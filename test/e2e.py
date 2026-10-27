"""End-to-end checks for Nib-E, run in headless Chromium against the single-file build.

Run:  npm run build:single && python3 test/e2e.py
Needs: playwright (Python), pikepdf, pdfplumber, poppler (pdftoppm), Pillow, numpy
"""
import base64
import functools
import http.server
import io
import json
import math
import os
import subprocess
import sys
import threading
import zipfile
from pathlib import Path

import pdfplumber
import pikepdf
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("NIB_TEST_OUT", ROOT / "test" / "out"))
OUT.mkdir(parents=True, exist_ok=True)
FIX = ROOT / "test" / "fixtures"
SAMPLE = FIX / "sample.pdf"
SAMPLE_NAME = "Heat transfer worksheet (sample).pdf"
if not (FIX / "photo.pdf").exists() or not (FIX / "mixed.pdf").exists() or not (FIX / "sample.pdf").exists():
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make-fixtures.py")], check=True)

results = []
VERSION = json.loads((ROOT / "package.json").read_text())["version"]


def check(name, ok, info=""):
    results.append((name, bool(ok), info))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({info})" if info else ""), flush=True)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist-single"))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# Saves go through a normal download in tests (headless Chrome cannot show "Save as").
# The first-run tour is marked as seen, except in the test that checks it.
NO_PICKER = "window.showSaveFilePicker = undefined; try { localStorage.setItem('nib.help.v1', '1'); } catch (e) {}"


def b64(path):
    return base64.b64encode(Path(path).read_bytes()).decode()


def export(page, opts=None):
    data = page.evaluate(
        """async (o) => {
            const bytes = await window.__nib.exportPdf(o || {});
            let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return btoa(s);
        }""",
        opts or {},
    )
    return base64.b64decode(data)


def open_fixture(page, path, name=None):
    page.evaluate(
        """async ([name, data]) => {
            const bin = atob(data); const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            await window.__nib.openBytes(name, u);
        }""",
        [name or Path(path).name, b64(path)],
    )
    page.wait_for_timeout(700)


def close_tab(page):
    """Closes the active tab without the unsaved-changes question."""
    page.evaluate("window.__nib.closeDoc(window.__nib.store.doc)")
    page.wait_for_timeout(200)


def make_fillable(page):
    page.wait_for_selector("#ask-fields:not([hidden])", timeout=8000)
    page.locator('#ask-fields [data-a="yes"]').click()
    page.wait_for_timeout(300)


def pages_state(page):
    return page.evaluate(
        "() => window.__nib.store.pages.map(p => ({key: p.key, src: p.src, index: p.index, rot: p.rot, base: p.baseRot, n: p.items.length, types: p.items.map(i => i.type), t: p.template, w: p.w, h: p.h}))"
    )


def items(page, i=0, lst="pages"):
    return page.evaluate(f"(i) => window.__nib.store.{lst}[i].items", i)


def tool(page, t):
    page.evaluate(f"window.__nib.store.setTool('{t}')")
    page.wait_for_timeout(60)


def paper(page, i, root="#pages"):
    return page.locator(f"{root} .sheet").nth(i).locator(".paper")


def bring(page, i, fy, root="#pages", scroller="#viewer"):
    page.evaluate(
        """([root, scroller, i, fy]) => {
            const v = document.querySelector(scroller);
            const r = document.querySelectorAll(root + ' .sheet .paper')[i].getBoundingClientRect();
            const vr = v.getBoundingClientRect();
            v.scrollTop += r.top + r.height * fy - (vr.top + vr.height / 2);
        }""",
        [root, scroller, i, fy],
    )
    page.wait_for_timeout(200)


def drag(page, i, pts, root="#pages", scroller="#viewer", steps=6):
    bring(page, i, pts[0][1], root, scroller)
    b = paper(page, i, root).bounding_box()
    page.mouse.move(b["x"] + pts[0][0] * b["width"], b["y"] + pts[0][1] * b["height"])
    page.mouse.down()
    for fx, fy in pts[1:]:
        page.mouse.move(b["x"] + fx * b["width"], b["y"] + fy * b["height"], steps=steps)
    page.mouse.up()
    page.wait_for_timeout(150)


def click_at(page, i, fx, fy, root="#pages", scroller="#viewer"):
    bring(page, i, fy, root, scroller)
    b = paper(page, i, root).bounding_box()
    page.mouse.click(b["x"] + fx * b["width"], b["y"] + fy * b["height"])
    page.wait_for_timeout(200)


def download(page, action, path):
    with page.expect_download(timeout=30000) as dl:
        action()
    dl.value.save_as(path)
    return Path(path)


def all_stream_bytes(pdf):
    out = b""
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Stream):
            try:
                out += obj.read_bytes()
            except Exception:
                pass
    return out


def main():
    # Text recognition files sit next to the app (the website and desktop builds copy them too).
    if not (ROOT / "dist-single" / "ocr" / "worker.min.js").exists():
        subprocess.run(["node", "scripts/copy-ocr.mjs", "dist-single"], cwd=ROOT, check=True)
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # Security rules (CSP) in force: the app works and cannot reach the network.
        cctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        cctx.add_init_script(NO_PICKER)
        cp = cctx.new_page()
        cp.on("pageerror", lambda e: errors.append(str(e)))
        cp.goto(url)
        cp.wait_for_selector(".app.ready", timeout=20000)
        open_fixture(cp, SAMPLE, SAMPLE_NAME)
        net = cp.evaluate("fetch('https://example.com/x').then(() => 'reached', () => 'blocked')")
        ok_csp = cp.evaluate("window.__nib.store.pages.length") == 3 and cp.locator("#pages canvas").count() > 0
        check("Network: none — with its security rules on, Nib-E works and cannot connect anywhere", net == "blocked" and ok_csp and cp.locator("meta[data-nib-csp]").count() == 1)
        cctx.close()

        # The rest runs with the rules relaxed so the test robot can drive the page.
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, accept_downloads=True, bypass_csp=True)
        ctx.add_init_script(NO_PICKER)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_selector(".app.ready", timeout=20000)
        page.wait_for_timeout(800)
        check("big interface on a 1440 px window hides the thumbnails to make room", page.evaluate("window.__nib.store.prefs.leftOpen") is False)
        page.screenshot(path=str(OUT / "00-start-empty.png"))
        check("starts empty (no example file); Save, Study and Full page wait for a file",
              page.evaluate("window.__nib.store.tabs.length") == 0 and page.locator("#empty").is_visible()
              and all(page.locator(f"#{b}").is_disabled() for b in ("btn-save", "btn-study", "btn-full", "btn-merge")))
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.locator("#edge-left").click()
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "01-desktop-sample.png"))

        st = pages_state(page)
        check("sample opens with 3 pages", len(st) == 3, f"{len(st)} pages")
        check("safe chip shows no blocked items for sample", "blocked" not in page.locator("#btn-check").inner_text())
        check("all-tools list shows 19 tools (with Settings)", page.locator("#panel-body .tool-row[data-view]").count() == 19)
        check("interface is 150% by default", page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ui').trim()") == "1.5" and abs(page.locator(".topbar").bounding_box()["height"] - 78) < 2, str(page.locator(".topbar").bounding_box()["height"]))
        check("tour does not open once seen", page.locator("#help-dialog").count() == 0)
        page.locator("#btn-tools").click()
        page.wait_for_timeout(200)
        closed = page.evaluate("getComputedStyle(document.getElementById('main')).gridTemplateColumns").endswith(" 0px")
        page.locator("#btn-tools").click()
        page.wait_for_timeout(200)
        check("Tools button hides and shows the tools panel", closed and page.locator("#panel").is_visible() and page.locator("#btn-tools").get_attribute("aria-pressed") == "true")

        # ---- pen, highlighter, eraser, undo ----
        tool(page, "pen")
        drag(page, 0, [(0.12, 0.40), (0.22, 0.43), (0.32, 0.41), (0.42, 0.45)])
        tool(page, "highlighter")
        drag(page, 0, [(0.10, 0.28), (0.60, 0.28)])
        check("pen + highlighter strokes recorded", len(items(page)) == 2)
        tool(page, "pen")
        drag(page, 0, [(0.70, 0.90), (0.80, 0.92)])
        tool(page, "eraser")
        drag(page, 0, [(0.75, 0.86), (0.75, 0.96)])
        check("eraser removes only the touched stroke", len(items(page)) == 2)
        page.keyboard.press("Control+z")
        check("undo restores erased stroke", len(items(page)) == 3)
        page.keyboard.press("Control+Shift+z")
        check("redo erases it again", len(items(page)) == 2)

        # ---- pen smoothness: a shaky mouse line, per pen feel ----
        def shaky_line(feel, fy):
            page.evaluate(f"window.__nib.store.setPrefs({{ penFeel: '{feel}' }})")
            tool(page, "pen")
            bring(page, 0, fy)
            b = paper(page, 0).bounding_box()
            x0, y0 = b["x"] + 0.15 * b["width"], b["y"] + fy * b["height"]
            page.mouse.move(x0, y0)
            page.mouse.down()
            for k in range(1, 61):
                jitter = 1.2 if k % 2 else -1.2  # pixel noise like a cheap mouse or a shaky hand
                page.mouse.move(x0 + k * 6, y0 + jitter)
                page.wait_for_timeout(8)
            page.mouse.up()
            page.wait_for_timeout(150)
            ink = [it for it in items(page) if it["type"] == "ink"][-1]
            ys = [p[1] for p in ink["pts"][3:-3]]
            mean = sum(ys) / len(ys)
            rms = math.sqrt(sum((y - mean) ** 2 for y in ys) / len(ys))
            k = page.evaluate("window.__nib.store.zoom * 96 / 72")
            page.keyboard.press("Control+z")
            return rms * k, ink

        rms_smooth, _ = shaky_line("smooth", 0.6)
        check("pen feel Smooth: shaky line comes out straight (wobble < 0.2 px)", rms_smooth < 0.2, f"rms {rms_smooth:.3f} px of ±1.2 px input")
        rms_bal, ink = shaky_line("balanced", 0.62)
        check("pen feel Balanced (default): jitter still removed (< 0.5 px of 1.2)", rms_bal < 0.5 and rms_bal > rms_smooth, f"rms {rms_bal:.3f} px")
        check("strokes remember their pen feel", ink.get("feel") == "balanced")
        check("mouse strokes have even width (no fake pressure)", ink["sim"] is True)
        page.evaluate("window.__nib.store.setPrefs({ penFeel: 'balanced' })")
        tool(page, "pen")
        check("dock shows the pen feel button", "Balanced" in page.locator("#dock").inner_text())
        k = page.evaluate("window.__nib.store.zoom * 96 / 72")

        # ---- real form fields in the sample ----
        tool(page, "hand")
        page.wait_for_timeout(300)
        fields = page.locator("#pages .sheet").nth(0).locator(".layer-forms .field")
        check("real form fields clickable in hand mode", fields.count() == 3, f"{fields.count()}")
        bring(page, 0, 0.2)
        page.locator("#pages .sheet").nth(0).locator(".field-text").first.click()
        page.keyboard.type("Ada Lovelace")
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        page.locator("#pages .sheet").nth(0).locator(".field-toggle").first.click()
        page.wait_for_timeout(400)

        # ---- text tool + font toolbar + select/move/delete ----
        tool(page, "text")
        click_at(page, 0, 0.62, 0.92)
        page.keyboard.type("Free note")
        check("text toolbar appears while typing", page.locator("#ctxbar").is_visible())
        page.locator('#ctxbar [data-a="bigger"]').click()
        page.locator('#ctxbar [data-a="bold"]').click()
        page.locator("#ctx-font").select_option("serif")
        page.wait_for_timeout(100)
        page.keyboard.press("Control+Enter")
        page.wait_for_timeout(200)
        t = [it for it in items(page) if it["type"] == "text"]
        check("text box created with toolbar style", len(t) == 1 and t[0]["text"] == "Free note" and t[0]["bold"] and t[0]["font"] == "serif" and t[0]["size"] > 11, json.dumps(t[0] if t else {})[:160])
        tool(page, "select")
        b = paper(page, 0).bounding_box()
        tx = b["x"] + (t[0]["x"] + 4) * k
        ty = b["y"] + (t[0]["y"] + t[0]["h"] / 2) * k
        page.mouse.move(tx, ty)
        page.mouse.down()
        page.mouse.move(tx + 40, ty - 30, steps=5)
        page.mouse.up()
        page.wait_for_timeout(200)
        t2 = [it for it in items(page) if it["type"] == "text"][0]
        check("select tool moves the text box", abs(t2["x"] - t[0]["x"] - 40 / k) < 1.5 and abs(t2["y"] - t[0]["y"] + 30 / k) < 1.5, f"dx {(t2['x'] - t[0]['x']) * k:.1f}px")
        page.screenshot(path=str(OUT / "02-text-and-select.png"))

        # ---- comments: shape, arrow, note, stamp, link ----
        tool(page, "shape")
        page.evaluate("window.__nib.store.setPrefs({ shape: 'rect' })")
        drag(page, 1, [(0.15, 0.62), (0.45, 0.72)])
        page.evaluate("window.__nib.store.setPrefs({ shape: 'arrow' })")
        drag(page, 1, [(0.55, 0.62), (0.85, 0.70)])
        tool(page, "note")
        click_at(page, 1, 0.8, 0.3)
        page.locator(".note-pop textarea").fill("Check units")
        page.locator('.note-pop [data-a="ok"]').click()
        page.wait_for_timeout(200)
        tool(page, "stamp")
        click_at(page, 1, 0.7, 0.85)
        st0 = [i for i in items(page, 1) if i["type"] == "stamp"][0]
        h = page.locator(".sel-box .h-se").bounding_box()
        page.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
        page.mouse.down()
        page.mouse.move(h["x"] + 40, h["y"] + 30, steps=5)
        page.mouse.up()
        page.wait_for_timeout(200)
        st1 = [i for i in items(page, 1) if i["type"] == "stamp"][0]
        check("corner handle resizes the stamp (keeps its shape)", st1["w"] > st0["w"] + 10 and abs(st1["w"] / st1["h"] - st0["w"] / st0["h"]) < 0.05, f"{st0['w']:.0f}x{st0['h']:.0f} -> {st1['w']:.0f}x{st1['h']:.0f}")
        tool(page, "link")
        drag(page, 1, [(0.1, 0.9), (0.4, 0.93)])
        page.locator("#modal-input").fill("example.com/units")
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_timeout(200)
        types = [it["type"] for it in items(page, 1)]
        check("shapes, note, stamp and link added", types.count("shape") == 2 and "note" in types and "stamp" in types and "link" in types, str(types))

        # ---- header/footer + watermark via the panel ----
        page.evaluate("window.__nib.store.setPanel('hf')")
        page.locator('#panel-body [data-act="hf-apply"]').click()
        page.evaluate("window.__nib.store.setPanel('wm')")
        page.locator('#panel-body [data-act="wm-apply"]').click()
        page.wait_for_timeout(300)
        check("header/footer and watermark stored", page.evaluate("!!window.__nib.store.plan.hf && !!window.__nib.store.plan.wm"))

        # ---- page ops ----
        page.evaluate("window.__nib.viewer.scrollToPage(0, false)")
        page.locator('#side-actions [data-act="insert"]').click()
        page.locator('#side-actions [data-tpl="lined"]').click()
        page.wait_for_timeout(300)
        st = pages_state(page)
        check("lined page inserted after page 1", len(st) == 4 and st[1]["src"] is None and st[1]["t"] == "lined")
        tool(page, "pen")
        drag(page, 1, [(0.2, 0.2), (0.5, 0.25), (0.7, 0.22)])
        page.locator(".thumb").nth(3).locator(".thumb-hit").click()
        page.wait_for_timeout(300)
        page.locator('#side-actions [data-act="rotR"]').click()
        check("rotate right applies to current page", pages_state(page)[3]["rot"] == 1)
        page.screenshot(path=str(OUT / "03-annotated.png"))

        pdf = export(page)
        (OUT / "export-sample.pdf").write_bytes(pdf)
        with pikepdf.open(io.BytesIO(pdf)) as doc:
            check("export has 4 pages", len(doc.pages) == 4)
            rots = [int(p.obj.get("/Rotate", 0)) for p in doc.pages]
            check("rotation saved", rots == [0, 0, 0, 90], str(rots))
            subs = [[str(a.get("/Subtype")) for a in (p.obj.get("/Annots") or []) if a.get("/Subtype") != "/Widget"] for p in doc.pages]
            check("ink saved as ink annotations", subs[0].count("/Ink") == 2 and subs[1].count("/Ink") == 1, str(subs[:2]))
            check("comments saved as PDF annotations", all(s in subs[2] for s in ("/Square", "/Ink", "/Text", "/Link")), str(subs[2]))
            note = [a for a in doc.pages[2].Annots if a.get("/Subtype") == "/Text"][0]
            check("sticky note text saved", str(note.Contents) == "Check units")
            link = [a for a in doc.pages[2].Annots if a.get("/Subtype") == "/Link"][0]
            check("link saved with https address", str(link.A.URI) == "https://example.com/units", str(link.A.get("/URI")))
            flds = {str(f.T): f for f in doc.Root.AcroForm.Fields}
            check("real form value saved", str(flds["student_name"].get("/V", "")) == "Ada Lovelace")
        with pdfplumber.open(io.BytesIO(pdf)) as d:
            p1 = d.pages[0].extract_text() or ""
            p3 = d.pages[2].extract_text() or ""
            words = d.pages[0].extract_words(extra_attrs=["fontname", "size"])
            free = [w for w in words if w["text"] in ("Free", "note")]
            check("typed text saved as real text with chosen font", free and free[0]["fontname"] == "Times-Bold", str([(w["text"], w["fontname"], round(w["size"], 1)) for w in free]))
            check("footer saved on every page", "Page 1 of 4" in p1 and "Page 3 of 4" in p3, p1[-40:].replace("\n", " "))
            wm = "".join(c["text"] for c in d.pages[0].chars if c["fontname"] == "Helvetica-Bold" and c["size"] > 40)
            check("watermark saved", wm == "CONFIDENTIAL", wm)
            check("stamp saved", "APPROVED" in p3)

        # ---- detected form boxes (form without real fields) ----
        sample_key = page.evaluate("window.__nib.store.doc.id")
        open_fixture(page, FIX / "form.pdf")
        page.wait_for_timeout(800)
        check("an edited file stays open in its own tab", page.evaluate("window.__nib.store.tabs.length") == 2 and page.locator("#tabbar .tab").count() == 2)
        n = page.evaluate("window.__nib.fieldCount()")
        check("form boxes detected on a form with no real fields", n == 9, f"{n}")
        check("boxes stay hidden until asked", page.locator("#pages .hot").count() == 0 and page.locator("#ask-fields").is_visible() and "9" in page.locator("#ask-fields").inner_text())
        page.screenshot(path=str(OUT / "04a-ask-fillable.png"))
        make_fillable(page)
        check("Make fillable shows the boxes, opens Form filling & signature, a tool that fills boxes", page.locator("#pages .hot").count() == 9 and page.evaluate("window.__nib.store.panel") == "fill" and page.evaluate("window.__nib.store.tool") in ("hand", "select") and page.locator("#ask-fields").is_hidden())
        hot = page.locator("#pages .sheet").nth(0).locator(".hot-text")
        hot.nth(0).click()
        page.keyboard.type("Morgan")
        page.keyboard.press("Tab")
        page.keyboard.type("Alex")
        page.keyboard.press("Enter")
        page.keyboard.type("01.01.2000")
        page.keyboard.press("Tab")
        page.wait_for_timeout(200)
        page.keyboard.type("Göttingen")
        page.keyboard.press("Tab")
        page.keyboard.type("Alex M.")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        radios = page.locator("#pages .sheet").nth(0).locator(".hot-radio")
        radios.nth(0).click()
        page.wait_for_timeout(150)
        radios.nth(1).click()
        page.wait_for_timeout(150)
        page.locator("#pages .sheet").nth(0).locator(".hot-check").nth(1).click()
        page.wait_for_timeout(200)
        its = items(page)
        texts = [i["text"] for i in its if i["type"] == "text"]
        marks = [i for i in its if i["type"] == "mark"]
        check("typing + Tab/Enter fills boxes in order; Esc keeps the text", texts == ["Morgan", "Alex", "01.01.2000", "Göttingen", "Alex M."], str(texts))
        check("radio choice replaces the other; checkbox ticks", len(marks) == 2 and sorted(m["shape"] for m in marks) == ["check", "dot"], str([m["shape"] for m in marks]))
        page.screenshot(path=str(OUT / "04-form-filled.png"))
        pdf = export(page, {"fillable": False})
        (OUT / "form-filled.pdf").write_bytes(pdf)
        with pdfplumber.open(io.BytesIO(pdf)) as d:
            w = [x for x in d.pages[0].extract_words(extra_attrs=["fontname", "size"]) if x["text"] == "Alex"]
            check("answers use the label's font and size (Times 12)", w and w[0]["fontname"] == "Times-Roman" and abs(w[0]["size"] - 12) < 0.1, str([(x["fontname"], x["size"]) for x in w]))
            check("umlauts saved", "Göttingen" in (d.pages[0].extract_text() or ""))
        pdf = export(page, {"fillable": True})
        (OUT / "form-fillable.pdf").write_bytes(pdf)
        with pikepdf.open(io.BytesIO(pdf)) as d:
            fl = list(d.Root.AcroForm.Fields)
            by = {str(f.T): f for f in fl}
            radio = [f for f in fl if str(f.get("/FT")) == "/Btn" and len(f.get("/Kids", [])) == 2]
            check("Make fillable: 8 fields (radios grouped)", len(fl) == 8, f"{len(fl)}: {list(by)}")
            check("Make fillable: typed answers become values", str(by.get("Surname", {}).get("/V", "")) == "Morgan" and str(by.get("City", {}).get("/V", "")) == "Göttingen")
            check("Make fillable: radio group named after the question", len(radio) == 1 and str(radio[0].T) == "Student")
        with pdfplumber.open(io.BytesIO(pdf)) as d:
            check("Make fillable: answers are not printed twice", (d.pages[0].extract_text() or "").count("Alex") == 0)

        # ---- tabs: switching keeps each file's state ----
        page.locator(f'#tabbar [data-open="{sample_key}"]').click()
        page.wait_for_timeout(500)
        check("switching tabs shows the other file with its edits", page.evaluate("window.__nib.store.doc.name").startswith("Heat") and len(pages_state(page)) == 4 and page.evaluate("window.__nib.store.canUndo"))
        page.locator("#tabbar .tab:not(.on) .tab-main").click()
        page.wait_for_timeout(400)
        check("...and back, answers still there", page.evaluate("window.__nib.store.doc.name") == "form.pdf" and len([i for i in items(page) if i["type"] == "text"]) == 5)

        # ---- rename by double-click, Save uses the new name ----
        page.locator("#docname").dblclick()
        page.locator("#docname input").fill("Membership 2026")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        check("double-click renames the file", page.evaluate("window.__nib.store.doc.name") == "Membership 2026.pdf" and "Membership 2026" in page.locator("#tabbar .tab.on").inner_text())
        with page.expect_download(timeout=30000) as dl:
            page.locator("#btn-save").click()
        dl.value.save_as(OUT / "renamed.pdf")
        check("Save uses the new name", dl.value.suggested_filename == "Membership 2026.pdf" and page.evaluate("window.__nib.store.dirty") is False, dl.value.suggested_filename)

        # ---- crash recovery: unsaved work comes back in a new window ----
        tool(page, "pen")
        drag(page, 0, [(0.3, 0.6), (0.6, 0.62)])
        rec_name = page.evaluate("window.__nib.store.doc.name")
        rec_ink = len([i for i in items(page) if i["type"] == "ink"])
        page.wait_for_timeout(3300)
        rp = ctx.new_page()
        rp.goto(url)
        rp.wait_for_selector(".app.ready", timeout=20000)
        rp.wait_for_timeout(600)
        check("another open Nib-E window does not offer live work", rp.locator("#modal[open]").count() == 0)
        rp.evaluate("() => { window.__nib.setRecoveryIdle(0); window.__nib.offerRecovery(); }")
        rp.wait_for_selector("#modal[open]", timeout=10000)
        check("after a crash, Nib-E offers the unsaved file", rec_name in rp.locator("#modal").inner_text())
        rp.locator("#modal .btn-primary").click()
        rp.wait_for_function("window.__nib.store.tabs.length > 0", timeout=15000)
        rp.wait_for_timeout(500)
        got = rp.evaluate("(n) => { const t = window.__nib.store.tabs.find(t => t.name === n); return t ? { ink: t.plan.pages[0].items.filter(i => i.type === 'ink').length, dirty: t.dirty } : null; }", rec_name)
        check("...and restores it with the changes, still unsaved", got is not None and got["ink"] == rec_ink and got["dirty"] is True, str(got))
        rp.evaluate("() => { for (const t of [...window.__nib.store.tabs]) window.__nib.store.removeTab(t); }")
        rp.close()

        # ---- closing a tab with changes asks first ----
        tool(page, "pen")
        drag(page, 0, [(0.3, 0.8), (0.5, 0.82)])
        page.locator("#tabbar .tab.on .tab-x").click()
        page.wait_for_selector("#modal[open]")
        q = page.locator("#modal").inner_text()
        page.locator('#modal [data-i="0"]').click()
        page.wait_for_timeout(200)
        check("closing an edited tab asks to save (Cancel keeps it)", "Save changes" in q and page.evaluate("window.__nib.store.tabs.length") == 2)
        unload = page.evaluate("() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }")
        check("closing the browser tab with unsaved changes asks first", unload is True)
        page.locator("#tabbar .tab.on .tab-x").click()
        page.wait_for_selector("#modal[open]")
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_timeout(300)
        check("Don't save closes the tab", page.evaluate("window.__nib.store.tabs.length") == 1 and page.locator("#tabbar .tab").count() == 0)

        # ---- detection also runs on files that have some real fields; decoration is skipped ----
        open_fixture(page, FIX / "mixed.pdf")
        page.wait_for_timeout(600)
        per_page = page.evaluate("[...window.__nib.store.doc.fields.entries()].map(([k, v]) => [k.split(':').pop(), v.map(f => f.label)])")
        check("form with real fields: other places on page 1 and page 2 still found", sorted(per_page) == [["0", ["Email"]], ["1", ["Phone", "Notes"]]], str(per_page))
        page.locator('#ask-fields .btn[data-a="no"]').click()
        page.wait_for_timeout(200)
        check("Not now hides the boxes for this file", page.evaluate("window.__nib.store.doc.fieldsOn") is False and page.locator("#pages .hot").count() == 0 and page.locator("#ask-fields").is_hidden())
        close_tab(page)

        # ---- text markup on real text ----
        open_fixture(page, FIX / "report.pdf")
        check("ordinary document: no form boxes", page.evaluate("window.__nib.fieldCount()") == 0)
        tool(page, "markup")
        page.evaluate("window.__nib.store.setPrefs({ markup: 'highlight' })")
        drag(page, 0, [(0.10, 0.135), (0.5, 0.135)])
        mk = [i for i in items(page) if i["type"] == "markup"]
        check("highlight snaps to text", len(mk) == 1 and len(mk[0]["rects"]) >= 1, str(mk[0]["rects"] if mk else None))
        pdf = export(page)
        with pikepdf.open(io.BytesIO(pdf)) as d:
            hl = [a for a in d.pages[0].Annots if a.get("/Subtype") == "/Highlight"]
            check("highlight saved with QuadPoints", hl and len(hl[0].QuadPoints) >= 8)

        # ---- redaction ----
        report_tab = page.evaluate("window.__nib.store.doc.id")
        page.evaluate("window.__nib.store.setPanel('redact')")
        page.locator("#pf-find").fill("South")
        page.locator('#panel-body [data-act="find-mark"]').click()
        page.wait_for_timeout(200)
        check("find text marks every match (any case)", page.evaluate("window.__nib.store.pages[0].items.filter(i => i.type === 'redact').length") == 2)
        tool(page, "redact")
        drag(page, 0, [(0.08, 0.005), (0.6, 0.11)])
        page.locator('#panel-body [data-act="redact-apply"]').click()
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name.includes('redacted')", timeout=20000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "05-redacted.png"))
        pdf = export(page)
        (OUT / "redacted.pdf").write_bytes(pdf)
        with pdfplumber.open(io.BytesIO(pdf)) as d:
            text = d.pages[0].extract_text() or ""
            check("redacted words are gone from the text", "South" not in text and "Quarterly" not in text and "North" in text, text[:80].replace("\n", " "))
        with pikepdf.open(io.BytesIO(pdf)) as d:
            raw = all_stream_bytes(d)
            hexs = "South".encode().hex().encode()
            check("redacted words are gone from the file bytes", b"South" not in raw and hexs not in raw.lower())
            check("hidden information removed (metadata)", "/Title" not in d.docinfo and "/Metadata" not in d.Root)
        check("redaction report shown", "Check passed" in page.locator("#panel-body").inner_text())
        check("redacted file replaces the original in the same tab", page.evaluate("window.__nib.store.doc.id") == report_tab)
        tool(page, "redact")
        drag(page, 0, [(0.6, 0.5), (0.8, 0.55)])
        page.locator('#panel-body [data-act="redact-apply"]').click()
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_function("window.__nib.store.pages[0].items.length === 0", timeout=20000)
        page.wait_for_timeout(300)
        check("redacting twice adds '(redacted)' only once", page.evaluate("window.__nib.store.doc.name") == "report (redacted).pdf", page.evaluate("window.__nib.store.doc.name"))
        close_tab(page)

        # ---- photo redaction erases pixels ----
        open_fixture(page, FIX / "photo.pdf")
        tool(page, "redact")
        drag(page, 0, [(0.12, 0.14), (0.35, 0.40)])
        page.evaluate("window.__nib.store.setPanel('redact')")
        page.locator('#panel-body [data-act="redact-apply"]').click()
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name.includes('redacted')", timeout=30000)
        pdf = export(page)
        with pikepdf.open(io.BytesIO(pdf)) as d:
            imgs = [x for x in d.pages[0].Resources.XObject.values() if x.get("/Subtype") == "/Image"]
            im = pikepdf.PdfImage(imgs[0]).as_pil_image().convert("RGB")
            px = im.getpixel((int(im.width * 0.1), int(im.height * 0.2)))
            check("photo pixels under the box are erased", sum(px) > 740 or sum(px) < 15, str(px))
        close_tab(page)

        # ---- compress ----
        open_fixture(page, FIX / "photo.pdf", "photo.pdf")
        page.evaluate("window.__nib.store.setPanel('compress')")
        before = (FIX / "photo.pdf").stat().st_size
        out = download(page, lambda: page.locator('#panel-body [data-act="compress"]').click(), OUT / "compressed.pdf")
        after = out.stat().st_size
        check("compress shrinks a large photo", after < before * 0.25, f"{before // 1024} KB -> {after // 1024} KB")
        subprocess.run(["pdftoppm", "-r", "30", "-png", str(out), str(OUT / "compressed")], check=True)
        im = Image.open(OUT / "compressed-1.png").convert("RGB")
        check("compressed photo still renders in place", sum(im.getpixel((int(im.width * 0.3), int(im.height * 0.3)))) < 700)

        # ---- protect ----
        page.evaluate("window.__nib.store.setPanel('protect')")
        page.locator("#pf-pw1").fill("geheim123")
        page.locator("#pf-pw2").fill("geheim123")
        out = download(page, lambda: page.locator('#panel-body [data-act="protect"]').click(), OUT / "protected.pdf")
        try:
            pikepdf.open(out)
            check("protected PDF needs a password", False)
        except pikepdf.PasswordError:
            check("protected PDF needs a password", True)
        with pikepdf.open(out, password="geheim123") as d:
            check("password opens it (AES-256)", d.encryption.bits == 256, str(d.encryption.bits))
        close_tab(page)

        # ---- export images ----
        open_fixture(page, FIX / "second.pdf")
        page.evaluate("window.__nib.store.setPanel('export')")
        out = download(page, lambda: page.locator('#panel-body [data-act="export"]').click(), OUT / "images.zip")
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            first = Image.open(io.BytesIO(z.read(names[0])))
            check("export pages as images: zip of PNGs at 150 dpi", len(names) == 2 and names[0].endswith(".png") and abs(first.width - 612 * 150 / 72) < 3, f"{names} {first.size}")
        close_tab(page)

        # ---- images -> PDF ----
        page.evaluate("window.__nib.store.setPanel('create')")
        with page.expect_file_chooser() as fc:
            page.locator('#panel-body [data-act="create-new"]').click()
        fc.value.set_files([str(FIX / "photo.png"), str(FIX / "photo.jpg")])
        page.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name === 'Images.pdf'", timeout=15000)
        check("images become a new 2-page PDF", len(pages_state(page)) == 2)

        # ---- add image onto a page ----
        page.evaluate("window.__nib.store.setPanel('edit')")
        with page.expect_file_chooser() as fc:
            page.locator('#panel-body [data-act="image"]').click()
        fc.value.set_files(str(FIX / "photo.png"))
        page.wait_for_timeout(500)
        click_at(page, 0, 0.5, 0.15)
        imgs = [i for i in items(page) if i["type"] == "image"]
        check("image placed on page", len(imgs) == 1 and page.evaluate("window.__nib.store.tool") == "select")
        pdf = export(page)
        with pikepdf.open(io.BytesIO(pdf)) as d:
            check("placed image saved", len([x for x in d.pages[0].Resources.XObject.values() if x.get("/Subtype") == "/Image"]) == 2)

        # ---- study mode ----
        was_dirty = page.evaluate("window.__nib.store.dirty")
        page.locator("#btn-study").click()
        page.wait_for_timeout(500)
        check("study mode shows the notebook with a lined page", page.locator("#notebook").is_visible() and page.evaluate("window.__nib.store.notes.map(n => n.template)") == ["lined"])
        fits = page.evaluate("() => ['#viewer', '#nb-viewer'].map(s => { const v = document.querySelector(s); return v.scrollWidth <= v.clientWidth + 1; })")
        check("study mode: both panes fit their pages (own zoom)", all(fits), str(fits))
        page.locator('#nb-tpl [data-tpl="grid"]').click()
        page.wait_for_timeout(200)
        check("notebook page switches to grid (not counted as an edit)", page.evaluate("window.__nib.store.notes[0].template") == "grid" and page.evaluate("window.__nib.store.dirty") == was_dirty)
        page.locator('#nb-tpl [data-tpl="blank"]').click()
        page.wait_for_timeout(200)
        check("...and to blank", page.evaluate("window.__nib.store.notes[0].template") == "blank" and page.locator('#nb-tpl [data-tpl="blank"]').get_attribute("aria-pressed") == "true")
        page.locator('#nb-tpl [data-tpl="lined"]').click()
        tool(page, "pen")
        drag(page, 0, [(0.2, 0.3), (0.5, 0.35), (0.7, 0.3)], root="#nb-pages", scroller="#nb-viewer")
        check("drawing in the notebook", len(items(page, 0, "notes")) == 1)
        page.locator("#nb-add").click()
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "06-study.png"))
        page.wait_for_timeout(1200)
        st = page.evaluate("({ book: window.__nib.store.doc.bookId, keep: window.__nib.store.doc.keep, dirty: window.__nib.store.doc.dirty })")
        check("study mode makes the file a study book, notes kept on this device", st["book"] is not None and st["keep"] == "device" and st["dirty"] is False, str(st))
        books = page.evaluate("window.__nib.listBooks().then(b => b.map(x => ({ id: x.id, notes: x.notePages, marks: x.plan.notes.reduce((n, p) => n + p.items.length, 0) })))")
        check("notes are written to the library as you write", any(b["id"] == st["book"] and b["notes"] == 2 and b["marks"] == 1 for b in books), str(books))
        check("top bar says notes are kept", page.locator("#docmeta .kept").count() == 1)
        page.locator("#btn-save").click()
        page.wait_for_timeout(500)
        check("Save on a study book keeps notes without writing a file", "saved on this device" in page.locator("#toasts").inner_text())
        out = download(page, lambda: page.evaluate("window.__nib.menuAction('with-notes')"), OUT / "study-notes.pdf")
        with pikepdf.open(out) as d:
            check("Export → PDF with my notes puts them at the end", len(d.pages) == 4, f"{len(d.pages)} pages")
        out = download(page, lambda: page.evaluate("window.__nib.menuAction('flat')"), OUT / "study-flat.pdf")
        with pikepdf.open(out) as d:
            annots = sum(len(pg.obj.get("/Annots") or []) for pg in d.pages)
            check("Export → Flattened PDF has no annotations left", len(d.pages) == 2 and annots == 0, f"{annots} annots")
        # Close and open the same book again: notes and page come back.
        book_bytes = page.evaluate("() => { const d = window.__nib.store.doc; const b = d.sources.get(d.primary).bytes; let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); }")
        book_name = page.evaluate("window.__nib.store.doc.name")
        page.evaluate("window.__nib.store.setCurrent(1)")
        page.wait_for_timeout(2600)
        page.evaluate("window.__nib.closeTab(window.__nib.store.doc)")
        page.wait_for_timeout(300)
        check("closing a study book does not ask (already kept)", page.locator("#modal[open]").count() == 0 and page.evaluate("window.__nib.store.tabs.every(t => t.name !== %s)" % json.dumps(book_name)))
        page.evaluate(
            """async ([name, data]) => { const bin = atob(data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__nib.openBytes(name, u); }""",
            [book_name, book_bytes],
        )
        page.wait_for_timeout(800)
        back = page.evaluate("({ notes: window.__nib.store.notes.length, ink: window.__nib.store.notes[0].items.length, current: window.__nib.store.current, book: window.__nib.store.doc.bookId })")
        check("reopening the book restores notes and the page you were on", back["notes"] == 2 and back["ink"] == 1 and back["current"] == 1 and back["book"] == st["book"], str(back))
        check("...with a welcome-back message", "Welcome back" in page.locator("#toasts").inner_text())
        page.screenshot(path=str(OUT / "06b-study-restored.png"))

        # Option B: write the notes into the book file.
        page.evaluate("window.__nib.store.setPanel('study')")
        page.locator('#panel-body input[name="pf-keep"][value="file"]').check()
        page.wait_for_timeout(300)
        check("switching to 'write notes into the book' marks it unsaved", page.evaluate("window.__nib.store.doc.keep") == "file" and page.evaluate("window.__nib.store.dirty") is True)
        out = download(page, lambda: page.locator("#btn-save").click(), OUT / "study-in-file.pdf")
        with pikepdf.open(out) as d:
            names = d.Root.get("/Names")
            emb = names.get("/EmbeddedFiles") if names is not None else None
            tagged = [a for a in (d.pages[0].obj.get("/Annots") or []) if a.get("/NibItem") is not None]
            check("book file holds note pages + Nib-E's notes attachment", len(d.pages) == 4 and emb is not None, f"{len(d.pages)} pages")
            check("Nib-E's own content is tagged in the file", len(tagged) >= 1 or b"NibItem" in d.pages[0].Contents.read_bytes() if hasattr(d.pages[0].Contents, 'read_bytes') else True)
        page.evaluate(
            """async ([name, data]) => { const bin = atob(data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__nib.openBytes(name, u); }""",
            ["study-in-file.pdf", base64.b64encode(out.read_bytes()).decode()],
        )
        page.wait_for_timeout(800)
        b2 = page.evaluate("({ pages: window.__nib.store.pages.length, notes: window.__nib.store.notes.length, ink: window.__nib.store.notes[0]?.items.length, keep: window.__nib.store.doc.keep, imgs: window.__nib.store.pages[0].items.filter(i => i.type === 'image').length, blocked: window.__nib.store.doc.reports.some(r => r.report.findings.some(f => f.id === 'attachments')) })")
        check("opening that file gives back the book, editable notes and marks", b2["pages"] == 2 and b2["notes"] == 2 and b2["ink"] == 1 and b2["keep"] == "file" and b2["imgs"] == 1, str(b2))
        check("Nib-E's own attachment is not reported as a risk", b2["blocked"] is False)
        plain = export(page, {"plain": True})
        with pikepdf.open(io.BytesIO(plain)) as d:
            imgs = [x for x in d.pages[0].Resources.XObject.values() if x.get("/Subtype") == "/Image"]
            check("...and Nib-E's marks were lifted off the page (not baked in)", len(d.pages) == 2 and len(imgs) == 1 and not (d.pages[0].obj.get("/Annots") or []), f"{len(imgs)} images")
        page.evaluate("window.__nib.store.setPrefs({ studyKeep: 'device' })")
        page.locator("#btn-study").click()

        # ---- custom stamps: designer and PNG ----
        page.evaluate("window.__nib.store.setPanel('stamp')")
        page.locator('#panel-body [data-act="stamp-design"]').click()
        page.wait_for_selector(".stamp-maker[open]")
        stage = page.locator(".sm-stage").bounding_box()
        # Drag the big word 40 px to the right, then rename it.
        page.mouse.move(stage["x"] + stage["width"] * 0.5, stage["y"] + stage["height"] * 0.42)
        page.mouse.down()
        page.mouse.move(stage["x"] + stage["width"] * 0.5 + 40, stage["y"] + stage["height"] * 0.42, steps=4)
        page.mouse.up()
        page.locator("#sm-text").fill("PASSED")
        page.locator('.stamp-maker [data-add="ellipse"]').click()
        page.locator("#sm-name").fill("Passed")
        page.screenshot(path=str(OUT / "10-stamp-designer.png"))
        page.locator('.stamp-maker [data-act="save"]').click()
        page.wait_for_timeout(600)
        st = page.evaluate("window.__nib.myStamps()")
        check("designed stamp is saved in the browser", len(st) == 1 and st[0]["name"] == "Passed" and any(e.get("text") == "PASSED" for e in st[0]["design"]))
        check("...and is ready to place", page.evaluate("window.__nib.store.tool") == "image" and page.evaluate("!!window.__nib.store.pendingImage"))
        click_at(page, 0, 0.5, 0.75)
        with page.expect_file_chooser() as fc:
            page.locator('#panel-body [data-act="stamp-png"]').click()
        fc.value.set_files(str(FIX / "photo.png"))
        page.wait_for_timeout(600)
        click_at(page, 0, 0.3, 0.9)
        check("PNG stamp added to My stamps", len(page.evaluate("window.__nib.myStamps()")) == 2 and page.locator("#panel-body .my-stamp").count() == 2)
        imgs = [i for i in items(page) if i["type"] == "image"]
        check("both stamps placed on the page", len(imgs) == 3 and max(max(i["w"], i["h"]) for i in imgs[1:]) <= 151, str([(round(i["w"]), round(i["h"])) for i in imgs]))
        pdf = export(page)
        with pikepdf.open(io.BytesIO(pdf)) as d:
            xo = [x for x in d.pages[0].Resources.XObject.values() if x.get("/Subtype") == "/Image"]
            check("designed stamp saved as a see-through image", any("/SMask" in x for x in xo), str(len(xo)))

        # ---- spelling ----
        tool(page, "text")
        click_at(page, 0, 0.2, 0.55)
        ta = page.locator(".text-editor")
        menu_ok = page.evaluate("() => { const t = document.querySelector('.text-editor'); const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); t.dispatchEvent(e); return !e.defaultPrevented; }")
        check("spelling check on while typing; right-click menu allowed", ta.get_attribute("spellcheck") == "true" and menu_ok)
        page.keyboard.press("Escape")
        page.evaluate("window.__nib.store.setPrefs({ spellLang: 'de' })")
        click_at(page, 0, 0.2, 0.6)
        check("spelling language follows Settings", page.locator(".text-editor").get_attribute("lang") == "de")
        page.keyboard.press("Escape")
        page.evaluate("window.__nib.store.setPrefs({ spellLang: '' })")

        # ---- full page + collapsible sides ----
        page.locator("#btn-full").click()
        page.wait_for_timeout(400)
        check("full page hides the chrome", page.evaluate("getComputedStyle(document.querySelector('.topbar')).visibility") == "hidden" and page.locator("#exit-full").is_visible())
        page.screenshot(path=str(OUT / "07-fullpage.png"))
        page.locator("#exit-full").click()
        page.wait_for_timeout(300)
        page.locator("#edge-left").click()
        page.locator("#edge-right").click()
        page.wait_for_timeout(300)
        cols = page.evaluate("getComputedStyle(document.getElementById('main')).gridTemplateColumns")
        check("arrows hide both side panels", cols.startswith("0px") and cols.endswith(" 0px"), cols)
        page.locator("#edge-left").click()
        page.locator("#edge-right").click()

        # ---- interface size ----
        page.evaluate("window.__nib.store.setPanel('settings')")
        page.locator('#panel-body input[name="pf-ui"][value="1"]').check()
        page.wait_for_timeout(300)
        h100 = page.locator(".topbar").bounding_box()["height"]
        page.screenshot(path=str(OUT / "11-size-100.png"))
        page.locator('#panel-body input[name="pf-ui"][value="2"]').check()
        page.wait_for_timeout(300)
        h200 = page.locator(".topbar").bounding_box()["height"]
        page.screenshot(path=str(OUT / "12-size-200.png"))
        check("interface size 100% to 200% doubles the top bar", abs(h100 - 52) < 2 and abs(h200 - 104) < 2, f"{h100} -> {h200}")
        fits = page.evaluate("() => { const v = document.querySelector('#viewer'); return v.scrollWidth <= v.clientWidth + 1; }")
        check("pages still fit at 200%", fits)
        page.locator('#panel-body input[name="pf-ui"][value="1.5"]').check()
        page.wait_for_timeout(200)

        # ---- tab limit ----
        for k in range(10):
            if page.evaluate("window.__nib.store.tabs.length") >= 8:
                break
            open_fixture(page, FIX / "second.pdf", f"copy {k}.pdf")
        page.evaluate("window.__nib.openBytes('one too many.pdf', new Uint8Array([37,80,68,70])).catch(e => { window.__tabErr = e.message; })")
        page.wait_for_timeout(300)
        check("at most 8 files open at once (clear message)", page.evaluate("window.__nib.store.tabs.length") == 8 and "Close one" in (page.evaluate("window.__tabErr") or ""), page.evaluate("window.__tabErr") or "")
        page.screenshot(path=str(OUT / "13-many-tabs.png"))
        while page.evaluate("window.__nib.store.tabs.length") > 1:
            close_tab(page)

        # ---- every tool view opens ----
        for v in ["edit", "fill", "form", "comment", "stamp", "redact", "organize", "combine", "compress", "protect", "export", "create", "study", "check", "hf", "wm", "settings", "home"]:
            page.evaluate(f"window.__nib.store.setPanel('{v}')")
        page.evaluate("window.__nib.store.setPanel('home')")
        groups = page.evaluate("[...document.querySelectorAll('#panel-body .tool-group-title')].map(h => h.textContent)")
        names = page.evaluate("[...document.querySelectorAll('#panel-body .tool-row .row-text > span:first-child')].map(s => s.textContent)")
        old = {"Edit PDF", "Fill & Sign", "Organize pages", "Combine files", "Compress a PDF", "Protect a PDF", "Redact a PDF", "Export PDF", "Scan & OCR", "Black out (redact)", "Merge files"}
        tile = page.evaluate("getComputedStyle(document.querySelector('#panel-body .tool-ico')).backgroundColor")
        check("Toolbox: grouped list in Nib-E's own words, plain icons", groups == ["Write", "Pages", "Protect", "Convert", "Study", "App", "Planned"] and "PDF redaction" in names and "Page manager" in names and not (old & set(names)) and tile in ("rgba(0, 0, 0, 0)", "transparent"), f"{groups} {names[:4]} {tile}")
        sv = page.evaluate("window.__nib.store.setPanel('settings'), document.querySelector('#panel-body').innerText")
        check("web build: Settings shows the plain version, no beta label", f"Nib-E {VERSION} · web" in sv and "beta" not in page.locator("header").inner_text().lower(), sv[-160:].replace("\n", " "))

        # ---- damaged pictures: detected; a file that was already damaged stays saveable ----
        def jpeg_pdf(path, damage):
            jpg = bytearray((FIX / "photo.jpg").read_bytes())
            if damage:
                i = jpg.index(b"\xff\xc4")
                jpg[i + 5] = 0x20  # Huffman count for length 1 becomes 32: impossible
            pdf = pikepdf.new()
            img = pikepdf.Stream(pdf, bytes(jpg))
            im = Image.open(io.BytesIO((FIX / "photo.jpg").read_bytes()))
            img.Type, img.Subtype, img.Width, img.Height = pikepdf.Name.XObject, pikepdf.Name.Image, im.width, im.height
            img.ColorSpace, img.BitsPerComponent, img.Filter = pikepdf.Name.DeviceRGB, 8, pikepdf.Name.DCTDecode
            pg = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 400, 300], Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img)))
            pg.Contents = pikepdf.Stream(pdf, b"q 400 0 0 300 0 0 cm /Im0 Do Q")
            pdf.pages.append(pikepdf.Page(pg))
            pdf.save(path)
        jpeg_pdf(OUT / "jpeg-ok.pdf", False)
        jpeg_pdf(OUT / "jpeg-damaged.pdf", True)
        res = page.evaluate(
            """async ([a, b]) => { const dec = (d) => { const bin = atob(d); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
                const ok = await window.__nib.checkImages(dec(a)); const bad = await window.__nib.checkImages(dec(b));
                return [ok.badPages, ok.checked, bad.badPages]; }""",
            [b64(OUT / "jpeg-ok.pdf"), b64(OUT / "jpeg-damaged.pdf")],
        )
        check("picture check: a good JPEG passes, a damaged one is found", res == [[], 1, [1]], str(res))
        open_fixture(page, OUT / "jpeg-damaged.pdf", "already-damaged.pdf")
        tool(page, "pen")
        drag(page, 0, [(0.2, 0.3), (0.5, 0.35)])
        out = download(page, lambda: page.locator("#btn-save").click(), OUT / "already-damaged-saved.pdf")
        check("a file that was already damaged can still be saved (only new damage stops Save)", out.exists() and out.stat().st_size > 1000)
        close_tab(page)

        # ---- Save writes over the opened file; the earlier version can be restored ----
        page.evaluate(
            """async (data) => {
                const bin = atob(data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
                const root = await navigator.storage.getDirectory();
                const h = await root.getFileHandle('opened.pdf', { create: true });
                const w = await h.createWritable(); await w.write(u); await w.close();
                window.__h = h;
                await window.__nib.openBytes('opened.pdf', u, { ref: { kind: 'fsa', handle: h } });
            }""",
            b64(FIX / "second.pdf"),
        )
        page.wait_for_timeout(700)
        def disk_inks():
            data = page.evaluate("async () => { const f = await window.__h.getFile(); const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); }")
            with pikepdf.open(io.BytesIO(base64.b64decode(data))) as d:
                return sum(1 for a in (d.pages[0].obj.get("/Annots") or []) if a.get("/Subtype") == "/Ink")
        check("Save menu says Save writes over the opened file", "opened.pdf" in page.evaluate("document.getElementById('btn-save').title"))
        tool(page, "pen")
        drag(page, 0, [(0.2, 0.3), (0.5, 0.32)])
        page.locator("#btn-save").click()
        page.wait_for_timeout(1200)
        check("Save writes over the opened file (no copy, no download)", disk_inks() == 1 and page.evaluate("window.__nib.store.dirty") is False and "Saved over" in page.locator("#toasts").inner_text())
        drag(page, 0, [(0.2, 0.5), (0.5, 0.52)])
        page.keyboard.press("Control+s")
        page.wait_for_timeout(1200)
        check("saving again updates the same file", disk_inks() == 2)
        page.locator("#btn-save-menu").click()
        page.wait_for_selector("#save-menu:not([hidden])")
        check("Save menu offers the earlier version", "Restore earlier version" in page.locator("#save-menu").inner_text())
        page.locator('#save-menu [data-menu="restore"]').click()
        page.wait_for_selector("#modal[open]")
        page.locator("#modal .btn-danger").click()
        page.wait_for_timeout(1500)
        check("Restore puts the version from before the last Save back on disk and reopens it", disk_inks() == 1 and page.evaluate("window.__nib.store.doc.name") == "opened.pdf" and len([i for i in items(page) if i["type"] == "ink"]) == 0)
        close_tab(page)
        page.close()

        # ---- palm rejection with a real pen ----
        tctx = browser.new_context(bypass_csp=True, viewport={"width": 1180, "height": 820}, has_touch=True)
        tctx.add_init_script("try { localStorage.setItem('nib.help.v1', '1'); } catch (e) {}")
        t = tctx.new_page()
        t.goto(url)
        t.wait_for_selector(".app.ready", timeout=20000)
        open_fixture(t, SAMPLE, SAMPLE_NAME)
        t.evaluate("window.__nib.store.setTool('pen')")
        t.wait_for_timeout(400)
        cdp = tctx.new_cdp_session(t)
        bb = t.locator("#pages .paper").first.bounding_box()
        x, y = bb["x"] + 200, bb["y"] + 420
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.7})
        for kk in range(1, 10):
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x + kk * 12, "y": y + kk * 3, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.3 + kk * 0.05})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x + 120, "y": y + 30, "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen"})
        t.wait_for_timeout(200)
        pen = t.evaluate("() => { const s = window.__nib.store.pages[0].items; return s.length ? { n: s.length, sim: s[0].sim, p: s[0].pts.map(q => q[2]) } : { n: 0 } }")
        check("pen input records real pressure", pen["n"] == 1 and pen.get("sim") is False and len(set(round(v, 2) for v in pen["p"])) > 2, str(pen)[:100])
        check("pen switches finger drawing off (palm rejection)", t.evaluate("window.__nib.store.prefs.fingerDraws") is False)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y + 100}]})
        for kk in range(1, 8):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + kk * 10, "y": y + 100 - kk * 15}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        t.wait_for_timeout(200)
        check("palm/finger touch does not draw after a pen was used", t.evaluate("window.__nib.store.pages[0].items.length") == 1)
        tctx.close()

        # ---- first run: the tour ----
        hctx = browser.new_context(bypass_csp=True, viewport={"width": 1440, "height": 900})
        hp = hctx.new_page()
        hp.on("pageerror", lambda e: errors.append(str(e)))
        hp.goto(url)
        hp.wait_for_selector(".app.ready", timeout=20000)
        hp.wait_for_selector("#help-dialog[open]", timeout=5000)
        hp.screenshot(path=str(OUT / "14-tour-1.png"))
        slides = hp.locator("#help-dialog .help-dot").count()
        hp.locator('#help-dialog [data-a="next"]').click()
        second = hp.locator("#help-dialog h2").inner_text()
        hp.screenshot(path=str(OUT / "15-tour-privacy.png"))
        hp.locator('#help-dialog [data-go="6"]').click()
        study = hp.locator("#help-dialog .help-slide").inner_text()
        hp.screenshot(path=str(OUT / "16-tour-study.png"))
        check("tour opens on first run; privacy is slide 2; study mode explained", slides == 9 and "never leave" in second and "Study" in study and "grid" in study, f"{slides} slides; {second}")
        hp.keyboard.press("Escape")
        hp.wait_for_timeout(200)
        hp.reload()
        hp.wait_for_selector(".app.ready", timeout=20000)
        hp.wait_for_timeout(500)
        check("tour does not come back after closing it", hp.locator("#help-dialog").count() == 0)
        hp.locator("#btn-help").click()
        hp.wait_for_selector("#help-menu:not([hidden])")
        hm = hp.locator("#help-menu").inner_text()
        check("Help opens a menu with tour, shortcuts, feedback, survey and about", all(w in hm for w in ["Help and tour", "Keyboard shortcuts", "Send feedback", "Take the survey", "About Nib-E"]), hm.replace("\n", " | ")[:200])
        hp.screenshot(path=str(OUT / "19-help-menu.png"))
        hp.locator('#help-menu [data-help="tour"]').click()
        check("...and the tour from there", hp.locator("#help-dialog[open]").count() == 1)
        hp.keyboard.press("Escape")
        hp.wait_for_timeout(200)
        hp.locator("#btn-help").click()
        hp.locator('#help-menu [data-help="feedback"]').click()
        hp.wait_for_selector("#modal[open] .feedback")
        hp.locator('#modal [data-kind="bug"]').click()
        hp.locator("#fb-text").fill("Text lands on the wrong line")
        sys_info = hp.locator("#fb-sys-text").inner_text()
        hp.screenshot(path=str(OUT / "20-feedback.png"))
        check("feedback: pick a kind, describe it, technical details shown (no file data)", f"Nib-E {VERSION} (web)" in sys_info and hp.locator("#modal [data-fb='copy']").is_visible() and hp.locator("#modal [data-fb='send']").is_visible(), sys_info)
        hp.evaluate("() => { window.__opened = null; window.__realOpen = window.open; window.open = (u) => { window.__opened = u; return null; }; }")
        hp.locator("#modal [data-fb='send']").click()
        hp.wait_for_timeout(300)
        opened = hp.evaluate("window.__opened") or ""
        hp.evaluate("() => { window.open = window.__realOpen; }")
        check("feedback opens the Google feedback form", "docs.google.com/forms" in opened, opened[:80])
        # Theme switch
        hp.evaluate("window.__nib.store.setPrefs({ theme: 'dark' })")
        dark = hp.evaluate("[document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--desk').trim()]")
        hp.evaluate("window.__nib.store.setPrefs({ theme: 'light' })")
        light = hp.evaluate("[document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--desk').trim()]")
        hp.evaluate("window.__nib.store.setPrefs({ theme: 'system' })")
        check("Settings: light / dark switch", dark == ["dark", "#0d0f15"] and light == ["light", "#e7eaf2"] and hp.evaluate("document.documentElement.dataset.theme") is None, f"{dark} {light}")
        # Logo opens the start page in a new tab
        with hctx.expect_page() as newp:
            hp.locator(".brand").click()
        np_ = newp.value
        np_.wait_for_selector(".app.ready", timeout=20000)
        lu = hp.evaluate("[window.__nib.landingUrl('https://example.github.io/Nib-E/app/'), window.__nib.landingUrl('https://example.github.io/Nib-E/app/index.html#x'), window.__nib.landingUrl('file:///home/me/Nib-E.html')]")
        check("on the website the logo leads to the landing page (one folder up from /app/)", lu == ["https://example.github.io/Nib-E/", "https://example.github.io/Nib-E/", None], str(lu))
        check("logo opens the start page in a new tab", np_.locator("#empty").is_visible() and "nib-e" in (hp.locator(".brand-word").text_content() or ""))
        hctx.close()

        # ---- phone + dark ----
        mctx = browser.new_context(bypass_csp=True, viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, color_scheme="dark")
        mctx.add_init_script("try { localStorage.setItem('nib.help.v1', '1'); } catch (e) {}")
        m = mctx.new_page()
        m.on("pageerror", lambda e: errors.append(str(e)))
        m.goto(url)
        m.wait_for_selector(".app.ready", timeout=20000)
        open_fixture(m, SAMPLE, SAMPLE_NAME)
        m.wait_for_timeout(600)
        m.screenshot(path=str(OUT / "08-phone-dark.png"))
        check("phone: no horizontal page overflow", not m.evaluate("() => document.documentElement.scrollWidth > window.innerWidth"))
        lay = m.evaluate("() => { const d = document.getElementById('dock').getBoundingClientRect(); return { phone: document.getElementById('app').classList.contains('phone'), ui: getComputedStyle(document.documentElement).getPropertyValue('--ui').trim(), left: d.left, right: d.right, bottom: d.bottom, w: innerWidth, h: innerHeight }; }")
        check("phone: 100 % interface and a tool bar across the bottom", lay["phone"] and lay["ui"] == "1" and lay["left"] <= 1 and lay["right"] >= lay["w"] - 1 and abs(lay["bottom"] - lay["h"]) <= 1, str(lay))
        small = m.evaluate("() => [...document.querySelectorAll('#dock .tool, #dock .icon-btn')].filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.width < 43.5 || r.height < 43.5).length")
        check("phone: touch targets are at least 44 px", small == 0, f"{small} smaller")
        m.locator(".dock-more").click()
        m.wait_for_timeout(400)
        sheet = m.locator("#panel").bounding_box()
        check("phone: More opens all tools as a sheet from the bottom", sheet and abs(sheet["y"] + sheet["height"] - 844) <= 2 and sheet["width"] >= 389 and sheet["y"] > 100, str(sheet))
        m.locator("#panel-close").click()
        m.wait_for_timeout(300)
        m.evaluate("window.__nib.store.setStudy(true)")
        m.wait_for_timeout(500)
        pdf_vis = m.locator("#viewer").is_visible() and not m.locator("#notebook").is_visible()
        m.locator('#study-tabs [data-side="notes"]').click()
        m.wait_for_timeout(400)
        nb_vis = m.locator("#notebook").is_visible() and not m.locator("#viewer").is_visible()
        m.screenshot(path=str(OUT / "08b-phone-study-notes.png"))
        check("phone: study mode switches between PDF and notes with tabs", pdf_vis and nb_vis)
        # Two fingers move the page while the pen is active.
        m.evaluate("window.__nib.store.setTool('pen')")
        m.locator('#study-tabs [data-side="pdf"]').click()
        m.wait_for_timeout(300)
        y0 = m.evaluate("document.getElementById('viewer').scrollTop")
        m.evaluate("""() => {
            const el = document.getElementById('pages');
            const ev = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, bubbles: true, buttons: 1 }));
            ev('pointerdown', 1, 150, 500); ev('pointerdown', 2, 250, 500);
            for (let k = 1; k <= 10; k++) { ev('pointermove', 1, 150, 500 - k * 20); ev('pointermove', 2, 250, 500 - k * 20); }
            ev('pointerup', 1, 150, 300); ev('pointerup', 2, 250, 300);
        }""")
        m.wait_for_timeout(200)
        y1 = m.evaluate("document.getElementById('viewer').scrollTop")
        inks = m.evaluate("window.__nib.store.pages[0].items.filter(i => i.type === 'ink').length")
        check("phone: two fingers scroll the page while the pen is on (no ink)", y1 - y0 > 120 and inks == 0, f"scrolled {y1 - y0}px, {inks} strokes")
        mctx.close()

        dctx = browser.new_context(bypass_csp=True, viewport={"width": 1280, "height": 820}, color_scheme="dark")
        dctx.add_init_script("try { localStorage.setItem('nib.help.v1', '1'); } catch (e) {}")
        d = dctx.new_page()
        d.goto(url)
        d.wait_for_selector(".app.ready", timeout=20000)
        open_fixture(d, SAMPLE, SAMPLE_NAME)
        d.wait_for_timeout(500)
        d.screenshot(path=str(OUT / "09-desktop-dark.png"))
        dctx.close()

        # ---- opened straight from disk (double-click) ----
        fctx = browser.new_context(bypass_csp=True, viewport={"width": 1280, "height": 820}, accept_downloads=True)
        fctx.add_init_script("try { localStorage.setItem('nib.help.v1', '1'); } catch (e) {}")
        f = fctx.new_page()
        f.goto((ROOT / "dist-single" / "Nib-E.html").as_uri())
        f.wait_for_selector(".app.ready", timeout=20000)
        check("Nib-E.html starts when opened from disk", True)
        f.set_input_files("#file-open", str(FIX / "second.pdf"))
        f.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name === 'second.pdf'", timeout=10000)
        check("opening a file from the empty start gives one tab", f.evaluate("window.__nib.store.tabs.length") == 1)

        # ---- full page with one file (was blank), and with study mode ----
        f.locator("#btn-full").click()
        f.wait_for_timeout(500)
        vp = f.viewport_size
        pb = f.locator("#pages .paper").first.bounding_box()
        main_h = f.evaluate("document.getElementById('main').getBoundingClientRect().height")
        f.screenshot(path=str(OUT / "07b-fullpage-one-file.png"))
        check("full page shows the page with a single file open (not blank)", main_h > vp["height"] * 0.95 and pb and pb["height"] > vp["height"] * 0.6 and pb["y"] < vp["height"] * 0.2, f"main {main_h:.0f}px, page {pb}")
        f.locator("#full-study").click()
        f.wait_for_timeout(700)
        nbb = f.locator("#notebook").bounding_box()
        bar = f.locator("#full-bar").bounding_box()
        nbp = f.locator("#nb-pages .paper").first.bounding_box()
        f.screenshot(path=str(OUT / "07c-fullpage-study.png"))
        check("study mode works inside full page (notebook beside the PDF)", f.evaluate("window.__nib.store.fullpage && window.__nib.store.study") and nbb and nbb["width"] > vp["width"] * 0.3 and nbp and nbp["height"] > 200)
        check("full-page buttons sit over the PDF, not over the notebook bar", bar and bar["x"] + bar["width"] <= nbb["x"])
        f.keyboard.press("Escape")
        f.wait_for_timeout(300)
        check("Esc leaves full page and keeps study mode", not f.evaluate("window.__nib.store.fullpage") and f.evaluate("window.__nib.store.study") and f.locator(".topbar").is_visible())
        f.locator("#btn-study").click()
        f.wait_for_timeout(300)
        f.evaluate("window.__nib.store.setTool('pen')")
        drag(f, 0, [(0.2, 0.3), (0.5, 0.35)])
        f.evaluate(
            """() => { window.__written = null; window.__picks = 0; window.showSaveFilePicker = async (o) => { window.__picks++; return { name: o.suggestedName, kind: 'file', getFile: async () => new File([window.__written || new Uint8Array()], o.suggestedName), createWritable: async () => ({ write: async (b) => { window.__written = new Uint8Array(await b.arrayBuffer()); }, close: async () => {} }) }; }; }"""
        )
        f.evaluate("window.__nib.store.setStudy(false)")
        f.evaluate("() => { const d = window.__nib.store.doc; d.bookId = null; d.keep = 'device'; d.dirty = true; }")
        f.locator("#btn-save").click()
        f.wait_for_function("window.__written !== null", timeout=15000)
        def written():
            data = f.evaluate("() => { const b = window.__written; let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); }")
            return pikepdf.open(io.BytesIO(base64.b64decode(data)))
        with written() as doc:
            inks = [a for a in (doc.pages[0].obj.get("/Annots") or []) if a.get("/Subtype") == "/Ink"]
            check("Save without a file asks where (Save window) and writes the PDF with the ink", len(doc.pages) == 2 and len(inks) == 1)
        check("...then the tab remembers that file", f.evaluate("!!window.__nib.store.doc.file") and f.evaluate("window.__picks") == 1)
        f.evaluate("window.__nib.store.setTool('pen')")
        drag(f, 0, [(0.2, 0.5), (0.5, 0.55)])
        f.evaluate("window.__written = null")
        f.locator("#btn-save").click()
        f.wait_for_function("window.__written !== null", timeout=15000)
        with written() as doc:
            inks = [a for a in (doc.pages[0].obj.get("/Annots") or []) if a.get("/Subtype") == "/Ink"]
            check("Save again writes over the same file without asking", len(inks) == 2 and f.evaluate("window.__picks") == 1, f"{len(inks)} inks, {f.evaluate('window.__picks')} picks")
        f.wait_for_timeout(300)
        f.locator("#btn-save-menu").click()
        f.wait_for_selector("#save-menu:not([hidden])")
        menu = f.locator("#save-menu").inner_text()
        check("Save menu lists Save as, Export and Print", all(w in menu for w in ["Save as", "Over “", "Flattened PDF", "Text (.txt)", "Print"]), menu.replace("\n", " | ")[:200])
        f.screenshot(path=str(OUT / "17-save-menu.png"))
        f.keyboard.press("Escape")
        f.evaluate("window.showSaveFilePicker = undefined")
        out = download(f, lambda: f.evaluate("window.__nib.menuAction('text')"), OUT / "export.txt")
        check("Export → Text writes the page text", "--- Page 1 ---" in out.read_text(errors="ignore"))
        # Print: pages are prepared as images for the system print dialog.
        f.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed = document.querySelectorAll('#print-root img').length; }; }")
        f.keyboard.press("Control+p")
        f.wait_for_selector("#modal[open] .print-form")
        f.screenshot(path=str(OUT / "18-print.png"))
        f.locator('#modal .print-form button[type="submit"]').click()
        f.wait_for_function("window.__printed > 0", timeout=20000)
        check("Print sends every page to the print dialog", f.evaluate("window.__printed") == 2)
        f.evaluate("window.__nib.store.doc.file = null")
        out = download(f, lambda: f.locator("#btn-save").click(), OUT / "saved-download.pdf")
        with pikepdf.open(out) as doc:
            check("Save (download route, Firefox/Safari) downloads the PDF", len(doc.pages) == 2)
        check("...and explains how to choose a folder", "Downloads" in f.locator("#toasts").inner_text())
        fctx.close()

        # ---------- 0.6.0: edit text, fonts, clipboard, two pages, attachments, signatures, print check, OCR, languages ----------
        vctx = browser.new_context(viewport={"width": 1400, "height": 1000}, device_scale_factor=1, accept_downloads=True, bypass_csp=True, permissions=["clipboard-read", "clipboard-write"])
        vctx.add_init_script(NO_PICKER)
        v = vctx.new_page()
        v.on("pageerror", lambda e: errors.append(str(e)))
        v.goto(url)
        v.wait_for_selector(".app.ready", timeout=20000)
        v.evaluate("window.__nib.store.setPanel('settings')")
        v.wait_for_timeout(200)
        check("Settings work before a PDF is open", v.locator("#pf-lang").count() == 1)
        v.evaluate("window.__nib.store.setPanel('home')")
        v.wait_for_timeout(200)
        check("tools that need a PDF are greyed out on the start screen", v.locator("#panel-body .tool-row.needs-doc").count() >= 10)

        A4W, A4H = 595.28, 841.89
        open_fixture(v, FIX / "retype.pdf")
        tool(v, "retype")
        click_at(v, 0, 80 / A4W, 145 / A4H)
        ta = v.locator("textarea.text-editor")
        check("Edit existing text: clicking a line opens it with its text", ta.count() == 1 and ta.input_value() == "Amount due: 1,250.00 EUR", ta.input_value() if ta.count() else "no editor")
        ta.fill("Amount due: 2,500.00 EUR")
        v.keyboard.press("Escape")
        v.wait_for_timeout(200)
        click_at(v, 0, 500 / A4W, 227 / A4H)
        check("...reads right alignment", v.evaluate("window.__nib.store.pages[0].items.at(-1)?.align") == "right" or (ta.count() and ta.input_value().startswith("Total")))
        ta.fill("Total: 99.00 EUR")
        v.keyboard.press("Escape")
        v.wait_for_timeout(200)
        it = v.evaluate("window.__nib.store.pages[0].items.map(i => ({t: i.text, a: i.align, pf: i.replace && i.replace.pdfFont}))")
        check("...two replaced lines with the PDF's font names", len(it) == 2 and all(x["pf"] for x in it) and it[1]["a"] == "right", str(it))
        out = export(v)
        (OUT / "retype-saved.pdf").write_bytes(out)
        with pdfplumber.open(io.BytesIO(out)) as pdf:
            txt = pdf.pages[0].extract_text() or ""
            right = [c for c in pdf.pages[0].chars if 220 < c["top"] < 235]
        check("...saved: old text gone, new text there", "2,500.00" in txt and "1,250.00 EUR\nPlease" not in txt and "99.00" in txt and "Total: 1,250" not in txt, txt.replace("\n", " | ")[:200])
        check("...right edge kept (within 2 pt)", right and abs(max(c["x1"] for c in right) - (A4W - 56)) < 2, str(round(max(c["x1"] for c in right), 1)) if right else "none")
        check("...neighbouring lines untouched", "Please pay within 14 days." in txt and "Customer: Hartmann GmbH, Regensburg" in txt)

        # Included fonts: Noto Sans keeps characters the standard fonts can't.
        tool(v, "text")
        click_at(v, 0, 0.2, 0.6)
        v.locator("textarea.text-editor").fill("Zaïre Ωmega Привет")
        v.keyboard.press("Escape")
        v.wait_for_timeout(200)
        v.evaluate("""() => { const s = window.__nib.store; s.updatePages((p) => p.key !== s.pages[0].key ? p : { ...p, items: p.items.map((x, k) => k === p.items.length - 1 ? { ...x, font: 'noto' } : x) }); }""")
        out = export(v)
        with pdfplumber.open(io.BytesIO(out)) as pdf:
            txt = pdf.pages[0].extract_text() or ""
            fonts = {c["fontname"] for c in pdf.pages[0].chars if c["text"] in "ΩП"}
        check("included font (Noto Sans) saves Greek and Cyrillic, embedded", "Ωmega" in txt and "Привет" in txt and any("Noto" in f for f in fonts), str(fonts))

        # Copy, paste, duplicate.
        tool(v, "select")
        n0 = len(items(v))
        v.evaluate("""() => { const s = window.__nib.store; const p = s.pages[0]; s.select({ key: p.key, id: p.items.at(-1).id }); }""")
        v.keyboard.press("Control+c")
        v.keyboard.press("Control+v")
        v.wait_for_timeout(200)
        v.keyboard.press("Control+d")
        v.wait_for_timeout(200)
        check("copy/paste and duplicate add copies of a text box", len(items(v)) == n0 + 2, f"{n0} → {len(items(v))}")
        close_tab(v)

        # Two-page view with title page.
        open_fixture(v, SAMPLE, SAMPLE_NAME)
        v.evaluate("window.__nib.store.setPrefs({ spread: 'cover' })")
        v.wait_for_timeout(400)
        boxes = [v.locator("#pages .sheet").nth(i).bounding_box() for i in range(3)]
        check("two pages + title page: page 1 alone, pages 2 and 3 side by side",
              abs(boxes[1]["y"] - boxes[2]["y"]) < 2 and boxes[2]["x"] > boxes[1]["x"] + 50 and boxes[1]["y"] > boxes[0]["y"] + 50)
        v.screenshot(path=str(OUT / "30-two-pages.png"))
        v.evaluate("window.__nib.store.setPrefs({ spread: 'single' })")
        close_tab(v)

        # Attachments, signatures, print check.
        open_fixture(v, FIX / "signed.pdf")
        v.evaluate("window.__nib.store.setPanel('signatures')")
        v.wait_for_selector(".sig-row", timeout=15000)
        badges = [v.locator(".sig-badge").nth(i).inner_text() for i in range(v.locator(".sig-badge").count())]
        check("Digital signatures: first changed by the later one, second intact", badges == ["Changed after", "Intact"], str(badges))
        with v.expect_file_chooser() as fc:
            v.click('[data-act="sig-pick"]')
        fc.value.set_files(str(FIX / "test-only-cert.p12"))
        v.wait_for_timeout(200)
        v.fill("#pf-sigpw", "test")
        v.click('[data-act="sig-sign"]')
        v.get_by_role("button", name="Sign and save", exact=True).wait_for(timeout=10000)
        signed = download(v, lambda: v.get_by_role("button", name="Sign and save", exact=True).click(), OUT / "signed-by-nib.pdf")
        ps = subprocess.run(["pdfsig", str(signed)], capture_output=True, text=True).stdout
        check("certificate signing: pdfsig says the new signature is valid", "Nib-E Test Signer" in ps and ps.count("Signature is Valid") >= 1, ps.replace("\n", " ")[-160:])
        v.evaluate("window.__nib.store.setPanel('printcheck')")
        v.click('[data-act="print-run"]')
        v.wait_for_selector("#panel-body .findings", timeout=15000)
        check("Print check lists fonts, images and bleed", "fonts" in v.locator("#panel-body").inner_text().lower() and "bleed" in v.locator("#panel-body").inner_text().lower())
        close_tab(v)

        # Text recognition on a scan, also when the page is turned.
        for fx in ("scan.pdf", "scan-rot.pdf"):
            open_fixture(v, FIX / fx)
            v.evaluate("window.__nib.store.setPanel('ocr')")
            v.wait_for_selector('[data-act="ocr-run"]', timeout=10000)
            v.click('[data-act="ocr-run"]')
            v.wait_for_selector("#panel-body .callout.ok", timeout=120000)
            out = export(v)
            with pdfplumber.open(io.BytesIO(out)) as pdf:
                txt = pdf.pages[0].extract_text() or ""
            check(f"Text recognition makes {fx} searchable", "Heat Transfer" in txt and "furnace" in txt, txt[:80].replace("\n", " | "))
            if fx == "scan.pdf":
                # The recognised text can be selected and copied in Nib-E itself.
                tool(v, "select")
                bring(v, 0, 0.08)
                pb = paper(v, 0).bounding_box()
                v.mouse.move(pb["x"] + 0.1 * pb["width"], pb["y"] + 0.076 * pb["height"])
                v.mouse.down()
                v.mouse.move(pb["x"] + 0.7 * pb["width"], pb["y"] + 0.08 * pb["height"], steps=6)
                v.mouse.up()
                v.keyboard.press("Control+c")
                v.wait_for_timeout(300)
                clip = v.evaluate("navigator.clipboard.readText()")
                check("...and its text can be selected and copied with the Select tool", "Heat Transfer" in clip, repr(clip[:60]))
            close_tab(v)

        # Selecting the PDF's own text: drag, double-click a word, triple-click a line, Ctrl+A.
        open_fixture(v, FIX / "retype.pdf")
        tool(v, "select")
        bring(v, 0, 0.17)
        pb = paper(v, 0).bounding_box()
        X = lambda x: pb["x"] + x / A4W * pb["width"]
        Y = lambda y: pb["y"] + y / A4H * pb["height"]
        v.mouse.move(X(58), Y(127))
        v.mouse.down()
        v.mouse.move(X(300), Y(146), steps=8)
        v.mouse.up()
        check("Select tool: dragging over text marks it and offers Copy", v.locator(".tsel-rect").count() >= 1 and v.locator(".tsel-copy").count() == 1)
        v.keyboard.press("Control+c")
        v.wait_for_timeout(300)
        clip = v.evaluate("navigator.clipboard.readText()")
        check("...Ctrl+C copies the selected text", clip == "Customer: Hartmann GmbH, Regensburg", repr(clip))
        v.mouse.click(X(120), Y(145))
        v.mouse.click(X(120), Y(145))
        v.locator(".tsel-copy").click()
        v.wait_for_timeout(300)
        check("...double-click selects a word", v.evaluate("navigator.clipboard.readText()") == "due")
        for _ in range(3):
            v.mouse.click(X(120), Y(145))
        v.keyboard.press("Control+c")
        v.wait_for_timeout(300)
        check("...triple-click selects the line", v.evaluate("navigator.clipboard.readText()") == "Amount due: 1,250.00 EUR")
        v.keyboard.press("Control+a")
        v.keyboard.press("Control+c")
        v.wait_for_timeout(300)
        check("...Ctrl+A selects the whole page", v.evaluate("navigator.clipboard.readText()").count("\n") >= 6)
        v.keyboard.press("Escape")
        check("...Esc clears the selection", v.locator(".tsel-rect").count() == 0 and len(items(v)) == 0)
        # Page layout button next to zoom.
        v.evaluate("window.__nib.store.setPrefs({ rightOpen: false })")
        v.wait_for_timeout(300)
        v.locator(".dock-layout").click()
        two = v.evaluate("window.__nib.store.prefs.spread")
        v.locator(".dock-layout").click()
        v.locator(".dock-layout").click()
        check("layout button next to zoom: one page → two pages → title page → one page", two == "two" and v.evaluate("window.__nib.store.prefs.spread") == "single")
        v.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        close_tab(v)

        # Real form fields of every kind (like the GemBox sample a tester sent).
        open_fixture(v, FIX / "form-fields.pdf")
        v.wait_for_timeout(600)
        fld = lambda t, i=0: v.locator(f'#pages .layer-forms > [title="{t}"]').nth(i)
        tool(v, "pen")
        v.wait_for_timeout(200)
        check("form fields are tinted with every tool (pen here) but let the pen through", v.evaluate("window.__nib.store.tool") == "pen" and v.locator("#pages .layer-forms > .field").count() >= 8 and v.locator("#pages .layer-forms.active").count() == 0)
        tool(v, "text")
        fld("FullName").click()
        check("Text tool on a field fills the field (no loose text)", "field-input" in v.evaluate("document.activeElement.className"))
        v.keyboard.type("Jamie Rivera")
        v.keyboard.press("Tab")
        v.wait_for_timeout(900)
        check("...Tab opens the next field; comb boxes type into their cells", "field-input-comb" in v.evaluate("document.activeElement.className") and v.evaluate("document.activeElement.maxLength") == 10)
        v.keyboard.type("123456789012")
        v.keyboard.press("Enter")
        v.wait_for_timeout(800)
        fld("Gender", 1).click()
        v.wait_for_timeout(600)
        fld("Married").click()
        v.wait_for_timeout(600)
        check("dropdown shows a ▼ chip", v.locator('#pages .layer-forms > [title="City"] .field-chip').count() == 1)
        fld("City").locator("select").select_option(label="Paris")
        v.wait_for_timeout(700)
        rows = v.locator('#pages .layer-forms > [title^="Language"] .field-row')
        check("list box shows its rows", rows.count() == 4)
        rows.nth(1).click()
        v.wait_for_timeout(700)
        v.locator('#pages .layer-forms > [title^="Language"] .field-row').nth(2).click()
        v.wait_for_timeout(700)
        fld("Notes").click()
        check("multi-line field opens a multi-line box", v.evaluate("document.activeElement.tagName") == "TEXTAREA")
        v.keyboard.type("First line")
        v.keyboard.press("Enter")
        v.keyboard.type("Second line")
        v.mouse.click(1300, 950)
        v.wait_for_timeout(900)
        check("no loose text was added on the form", len(items(v)) == 0)
        out = export(v)
        (OUT / "form-fields-filled.pdf").write_bytes(out)
        with pikepdf.open(io.BytesIO(out)) as pdf:
            af = pdf.Root.AcroForm
            vals = {str(f.T): f.get("/V") for f in af.Fields}
            da = str(af.get("/DA", ""))
            helv = "/DR" in af and "/Helv" in af.DR.Font
        check("saved: text, comb, radio, checkbox, dropdown, two list choices, two-line notes",
              str(vals["FullName"]) == "Jamie Rivera" and str(vals["ID"]) == "1234567890" and str(vals["Gender"]) == "/Female" and str(vals["Married"]) == "/Yes"
              and str(vals["City"]) == "Paris" and [str(x) for x in vals["Language"]] == ["German", "French"] and str(vals["Notes"]).replace("\r\n", "\n").replace("\r", "\n") == "First line\nSecond line",
              str({k: str(x) for k, x in vals.items()}))
        check("saved: a form without default font settings gets Helvetica (/DA, /DR)", "/Helv" in da and helv, da)
        txt = subprocess.run(["pdftotext", "-layout", str(OUT / "form-fields-filled.pdf"), "-"], capture_output=True, text=True).stdout
        check("...another PDF engine (poppler) shows the answers", "Jamie Rivera" in txt and "Paris" in txt and "Second line" in txt)
        fld("Reset the form").click()
        v.get_by_role("button", name="Reset", exact=True).click()
        v.wait_for_timeout(1200)
        out = export(v)
        with pikepdf.open(io.BytesIO(out)) as pdf:
            vals = {str(f.T): f.get("/V") for f in pdf.Root.AcroForm.Fields}
        check("Reset button clears the form (standard action, after a confirm)", not str(vals.get("FullName") or "") and str(vals.get("Married")) == "/Off" and not vals.get("City"), str({k: str(x) for k, x in vals.items()}))
        close_tab(v)

        # ---- 0.6.3 ----
        # A new file opens with the Select tool (the Pen made people draw by accident); Study mode starts with the Pen.
        tool(v, "pen")
        open_fixture(v, SAMPLE, SAMPLE_NAME)
        check("a newly opened file starts with the Select tool", v.evaluate("window.__nib.store.tool") == "select")
        v.evaluate("window.__nib.store.setStudy(true)")
        v.wait_for_timeout(300)
        check("...Study mode starts with the Pen", v.evaluate("window.__nib.store.tool") == "pen")
        v.evaluate("window.__nib.store.setStudy(false)")
        v.wait_for_timeout(300)

        # Crop: all pages from one drag, saved as a crop box; Undo brings the full pages back.
        v.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        v.evaluate("window.__nib.store.setPanel('organize')")
        v.wait_for_timeout(300)
        v.click('#panel-body [data-act="crop-scope"][data-val="all"]')
        check("Crop: choosing which pages switches to the Crop tool", v.evaluate("window.__nib.store.tool") == "crop")
        drag(v, 0, [(0.1, 0.05), (0.9, 0.5)], steps=8)
        crops = v.evaluate("window.__nib.store.pages.map(p => p.crop ? [p.crop.x, p.crop.y, p.crop.w, p.crop.h].map(Math.round) : null)")
        check("...one drag crops every page at the same spot", len(crops) == 3 and all(c and c == crops[0] for c in crops) and 40 < crops[0][0] < 80, str(crops))
        tool(v, "select")
        v.wait_for_timeout(300)
        shown = v.locator("#pages .sheet .paper").nth(0).evaluate("e => getComputedStyle(e).clipPath")
        check("...the page shows only the cropped part", shown.startswith("inset("), shown)
        out = export(v)
        with pikepdf.open(io.BytesIO(out)) as pdf:
            boxes = [[round(float(x)) for x in pg.obj.CropBox] if "/CropBox" in pg.obj else None for pg in pdf.pages]
        A4H_ = 842
        check("...saved with a crop box (nothing deleted)", all(b and b[2] - b[0] == crops[0][2] and b[3] == A4H_ - crops[0][1] for b in boxes), str(boxes))
        v.keyboard.press("Control+z")
        v.wait_for_timeout(300)
        check("...Undo shows the full pages again", v.evaluate("window.__nib.store.pages.every(p => !p.crop)"))

        # Redaction: the same area on all pages (off by default), and you stay on the page you were on.
        v.evaluate("window.__nib.store.setPanel('redact')")
        v.wait_for_timeout(300)
        check("Redaction: 'Same area on all pages' is off by default", not v.locator("#pf-redact-all").is_checked())
        v.check("#pf-redact-all")
        drag(v, 0, [(0.05, 0.035), (0.95, 0.09)], steps=6)
        per = v.evaluate("window.__nib.store.pages.map(p => p.items.filter(i => i.type === 'redact').length)")
        check("...one mark lands on every page", per == [1, 1, 1], str(per))
        v.evaluate("window.__nib.store.setCurrent(1)")
        v.evaluate("document.querySelectorAll('#pages .sheet')[1].scrollIntoView()")
        v.wait_for_timeout(400)
        top0 = v.evaluate("document.getElementById('viewer').scrollTop")
        v.click('#panel-body [data-act="redact-apply"]')
        v.locator('#modal [data-i="1"]').click()
        v.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name.includes('redacted')", timeout=30000)
        v.wait_for_timeout(900)
        check("...after redacting Nib-E stays on the same page and place", v.evaluate("window.__nib.store.current") == 1 and abs(v.evaluate("document.getElementById('viewer').scrollTop") - top0) < 30)
        out = export(v)
        with pdfplumber.open(io.BytesIO(out)) as pdf:
            tops = [[c["text"] for c in pg.chars if c["top"] < 0.085 * pg.height] for pg in pdf.pages]
        check("...the area is empty on every page (independent text extraction)", all(not t for t in tops), str([''.join(t)[:20] for t in tops]))
        check("...the redaction panel has the 'check the saved copy' note", "Beta" in v.locator("#panel-body").inner_text())
        close_tab(v)

        # Full page: the tool bar hides and comes back at the bottom edge.
        open_fixture(v, SAMPLE, SAMPLE_NAME)
        v.evaluate("window.__nib.store.setFullpage(true)")
        v.wait_for_timeout(500)
        v.mouse.move(600, 400)
        v.wait_for_timeout(1300)
        hidden = v.evaluate("getComputedStyle(document.getElementById('dock')).opacity")
        v.mouse.move(600, 990)
        v.wait_for_timeout(500)
        shown = v.evaluate("getComputedStyle(document.getElementById('dock')).opacity")
        check("Full page: the tool bar hides and shows at the bottom edge", hidden == "0" and shown == "1", f"{hidden} / {shown}")
        v.evaluate("window.__nib.store.setFullpage(false)")
        v.wait_for_timeout(300)

        # Editing text on a turned page: the typing box turns with the text.
        tool(v, "text")
        click_at(v, 0, 0.5, 0.6)
        v.keyboard.type("Turn me")
        v.keyboard.press("Escape")
        v.wait_for_timeout(200)
        v.evaluate("window.__nib.store.rotate([window.__nib.store.pages[0].key], 1)")
        v.wait_for_timeout(600)
        it = items(v)[-1]
        v.evaluate("""(id) => { const s = window.__nib.store; s.select({ key: s.pages[0].key, id }); }""", it["id"])
        bx = v.locator("#pages .sel-box").first.bounding_box()
        v.evaluate("window.__nib.store.select(null)")
        tool(v, "text")
        v.mouse.click(bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2)
        v.wait_for_timeout(300)
        tf = v.evaluate("(() => { const t = document.querySelector('textarea.text-editor'); return t ? getComputedStyle(t).transform : 'no editor'; })()")
        check("text box on a turned page: the editor is turned with it", tf not in ("none", ""), tf)
        v.keyboard.press("Escape")
        close_tab(v)

        # Form boxes on a turned page without their own rotation: answers read like the labels.
        open_fixture(v, FIX / "form-turned.pdf")
        v.wait_for_timeout(600)
        tool(v, "hand")
        v.locator('#pages .layer-forms > [title="FullName"]').first.click()
        v.keyboard.type("Jamie Rivera")
        v.keyboard.press("Tab")
        v.wait_for_timeout(800)
        v.keyboard.type("1234567890")
        full_scroll = v.evaluate("document.activeElement.scrollLeft")
        v.keyboard.press("Enter")
        v.wait_for_timeout(800)
        check("number boxes: a full box doesn't scroll (first digit stays visible)", full_scroll == 0, str(full_scroll))
        out = export(v)
        (OUT / "form-turned-filled.pdf").write_bytes(out)
        with pikepdf.open(io.BytesIO(out)) as pdf:
            rs = {str(a.get("/T")): int(a.MK.R) for a in pdf.pages[0].Annots if "/MK" in a and "/R" in a.MK}
            vals = {str(f.T): str(f.get("/V", "")) for f in pdf.Root.AcroForm.Fields}
        check("turned page: form boxes get the direction of the printed text (/MK /R 90)", rs.get("FullName") == 90 and rs.get("Notes") == 90, str(rs))
        check("...and keep the answers", vals.get("FullName") == "Jamie Rivera" and vals.get("ID") == "1234567890", str(vals))
        close_tab(v)
        vctx.close()

        # Interface language follows the system (German) and can be switched in Settings.
        lctx = browser.new_context(viewport={"width": 1280, "height": 820}, locale="de-DE", bypass_csp=True)
        lctx.add_init_script(NO_PICKER)
        lp = lctx.new_page()
        lp.on("pageerror", lambda e: errors.append(str(e)))
        lp.goto(url)
        lp.wait_for_selector(".app.ready", timeout=20000)
        lp.wait_for_timeout(300)
        check("German system: the interface is German", "PDF öffnen" in lp.locator("body").inner_text() and lp.evaluate("document.documentElement.lang") == "de")
        lp.evaluate("window.__nib.store.setPanel('settings')")
        lp.wait_for_timeout(200)
        lp.select_option("#pf-lang", "en")
        lp.wait_for_timeout(200)
        check("...switching to English restores English texts", "Open a PDF" in lp.locator("body").inner_text() and "PDF öffnen" not in lp.locator("body").inner_text())
        lctx.close()

        sctx = browser.new_context(bypass_csp=True, viewport={"width": 1280, "height": 820})
        s = sctx.new_page()
        s.goto((ROOT / "index.html").as_uri())
        s.wait_for_selector("#nib-not-started", timeout=15000)
        check("source index.html explains itself instead of hanging", "Nib-E.html" in s.locator("#nib-not-started").inner_text())
        sctx.close()
        browser.close()

    real_errors = [e for e in errors if "favicon" not in e and "example.com" not in e]
    check("no page errors", not real_errors, "; ".join(real_errors[:3]))
    srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
