"""Captures real Nib-E footage (stills of each step) for the trailer.

Run:  npm run build:single && python3 store/trailer/capture.py
Writes store/trailer/frames/*.png (3200x2000) and frames/meta.json with the
screen positions (in image pixels) the trailer's cursor moves to.
Uses only the made-up files in test/fixtures.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test"))

from e2e import FIX, NO_PICKER, SAMPLE, SAMPLE_NAME, click_at, drag, make_fillable, open_fixture, serve, tool  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).resolve().parent / "frames"
OUT.mkdir(parents=True, exist_ok=True)
W, H, S = 1600, 1000, 2
meta = {"size": [W * S, H * S]}


def shot(page, name):
    page.evaluate("document.getElementById('toasts')?.replaceChildren()")
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / f"{name}.png"))
    print("captured", name)


def deselect(page):
    page.evaluate("window.__nib.store.select(null)")
    page.wait_for_timeout(150)


def center(page, locator):
    b = page.locator(locator).first.bounding_box() if isinstance(locator, str) else locator.bounding_box()
    return [round((b["x"] + b["width"] / 2) * S), round((b["y"] + b["height"] / 2) * S)]


def box(page, locator):
    b = page.locator(locator).first.bounding_box() if isinstance(locator, str) else locator.bounding_box()
    return [round(b["x"] * S), round(b["y"] * S), round(b["width"] * S), round(b["height"] * S)]


def start(browser, url, dark=False):
    ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=S, bypass_csp=True, color_scheme="dark" if dark else "light")
    ctx.add_init_script(NO_PICKER + "; try { localStorage.removeItem('nib.signature.v1') } catch (e) {}")
    page = ctx.new_page()
    page.goto(url)
    page.wait_for_selector(".app.ready", timeout=20000)
    return ctx, page


def signature_path(n=140):
    """A flowing, looped scribble (like a cursive surname) plus a short underline, in pad fractions."""
    first = []  # a tall initial stroke, like a capital letter
    for i in range(31):
        t = i / 30
        first.append((0.12 + 0.07 * t + 0.03 * math.sin(math.pi * t), 0.70 - 0.48 * math.sin(math.pi * t * 0.95)))
    main = []  # loops getting smaller to the right (prolate cycloid)
    loops = 6.0
    for i in range(n + 1):
        t = i / n
        a = 2 * math.pi * loops * t
        r = 0.07 * (1 - 0.4 * t)
        x = 0.22 + 0.58 * t - r * 0.5 * math.sin(a)
        y = 0.6 - r * 3.4 * (1 - math.cos(a)) * 0.5 - 0.05 * math.sin(math.pi * t)
        main.append((x, y))
    under = [(0.20 + 0.62 * i / 24, 0.80 - 0.035 * math.sin(math.pi * i / 24)) for i in range(25)]
    return [first, main, under]


def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ---- start screen + form: ask, fill step by step ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        shot(page, "start")
        meta["start_open"] = center(page, "#empty .btn-primary")
        open_fixture(page, FIX / "form.pdf", "Membership form.pdf")
        page.wait_for_timeout(900)
        shot(page, "ask")
        meta["ask_yes"] = center(page, '#ask-fields [data-a="yes"]')
        make_fillable(page)
        deselect(page)
        page.wait_for_timeout(300)
        sheet = page.locator("#pages .sheet").nth(0)
        hot = sheet.locator(".hot-text")
        meta["fill_boxes"] = [center(page, hot.nth(i)) for i in range(hot.count())]
        sign_box = hot.nth(4).bounding_box()
        shot(page, "fill0")
        values = ["Hartmann", "Anna", "14.03.1999", "Regensburg"]
        for i, v in enumerate(values):
            hot.nth(i).click()
            page.keyboard.type(v)
            page.keyboard.press("Escape")
            deselect(page)
            shot(page, f"fill{i + 1}")
        radios = sheet.locator(".hot-radio")
        checks = sheet.locator(".hot-check")
        meta["fill_radio"] = center(page, radios.nth(1))
        meta["fill_check"] = center(page, checks.nth(1))
        radios.nth(1).click()
        deselect(page)
        shot(page, "fill5")
        checks.nth(1).click()
        deselect(page)
        shot(page, "fill6")

        # ---- signature: draw in the pad, place on the line ----
        meta["sign_line"] = meta["fill_boxes"][4]
        meta["sign_redraw"] = center(page, '#panel-body [data-act="redraw"]')
        page.locator('#panel-body [data-act="redraw"]').click()
        page.wait_for_selector("#sign-dialog[open]")
        page.wait_for_timeout(300)
        pad = page.locator("#sign-pad").bounding_box()
        meta["sign_pad"] = [round(pad["x"] * S), round(pad["y"] * S), round(pad["width"] * S), round(pad["height"] * S)]
        shot(page, "sign0")
        strokes = signature_path()
        pts_img = []
        k = 1
        for stroke in strokes:
            x0, y0 = stroke[0]
            page.mouse.move(pad["x"] + x0 * pad["width"], pad["y"] + y0 * pad["height"])
            page.mouse.down()
            for j, (x, y) in enumerate(stroke[1:], 1):
                page.mouse.move(pad["x"] + x * pad["width"], pad["y"] + y * pad["height"])
                pts_img.append([round((pad["x"] + x * pad["width"]) * S), round((pad["y"] + y * pad["height"]) * S)])
                if j % 20 == 0:
                    shot(page, f"sign{k}")
                    k += 1
            page.mouse.up()
        shot(page, f"sign{k}")
        meta["sign_frames"] = k
        meta["sign_strokes"] = [len(st) - 1 for st in strokes]
        meta["sign_pen"] = pts_img
        meta["sign_use"] = center(page, '#sign-dialog [data-act="use"]')
        page.locator('#sign-dialog [data-act="use"]').click()
        page.wait_for_timeout(300)
        # Place it on the right part of the line, clear of the printed hint text.
        lb = sign_box
        meta["sign_place"] = [round((lb["x"] + lb["width"] * 0.68) * S), round((lb["y"] + lb["height"] * 0.15) * S)]
        page.mouse.click(lb["x"] + lb["width"] * 0.68, lb["y"] + lb["height"] * 0.15)
        page.wait_for_timeout(300)
        tool(page, "hand")
        deselect(page)
        shot(page, "sign_done")
        ctx.close()

        # ---- study mode ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: false, textSize: 16 })")
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.wait_for_timeout(500)
        shot(page, "study_pdf")
        meta["study_btn"] = center(page, "#btn-study")
        page.locator("#btn-study").click()
        page.wait_for_timeout(700)
        shot(page, "study0")
        meta["study_paper"] = box(page, "#nb-pages .sheet .paper")
        nb = dict(root="#nb-pages", scroller="#nb-viewer")
        tool(page, "pen")
        meta["study_pen"] = center(page, '#dock [data-tool="pen"]')
        strokes = [
            [(0.14, 0.22), (0.14, 0.42), (0.52, 0.42)],
            [(0.16, 0.25), (0.26, 0.29), (0.36, 0.34), (0.48, 0.39)],
            [(0.30, 0.20), (0.30, 0.44)],
            [(0.58, 0.30), (0.76, 0.30)],
            [(0.72, 0.27), (0.76, 0.30), (0.72, 0.33)],
        ]
        meta["study_strokes"] = strokes
        for i, s in enumerate(strokes, 1):
            drag(page, 0, s, **nb, steps=10)
            page.mouse.move(5, 500)
            shot(page, f"study{i}")
        tool(page, "text")
        click_at(page, 0, 0.14, 0.10, **nb)
        page.keyboard.type("Fourier: q = -k · dT/dx")
        page.keyboard.press("Escape")
        click_at(page, 0, 0.56, 0.36, **nb)
        page.keyboard.type("heat flows hot → cold")
        page.keyboard.press("Escape")
        tool(page, "hand")
        deselect(page)
        shot(page, "study6")
        ctx.close()

        # ---- redaction ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, FIX / "report.pdf", "Quarterly report.pdf")
        page.evaluate("window.__nib.store.setPanel('redact')")
        page.wait_for_timeout(400)
        shot(page, "redact0")
        meta["redact_find"] = center(page, "#pf-find")
        meta["redact_mark"] = center(page, '#panel-body [data-act="find-mark"]')
        page.locator("#pf-find").fill("South")
        shot(page, "redact1")
        page.locator('#panel-body [data-act="find-mark"]').click()
        page.wait_for_timeout(300)
        tool(page, "hand")
        shot(page, "redact2")
        meta["redact_apply"] = center(page, '#panel-body [data-act="redact-apply"]')
        page.locator('#panel-body [data-act="redact-apply"]').click()
        page.locator('#modal [data-i="1"]').click()
        page.wait_for_function("window.__nib.store.doc && window.__nib.store.doc.name.includes('redacted')", timeout=30000)
        page.wait_for_timeout(600)
        shot(page, "redact3")
        ctx.close()

        # ---- toolbox and dark mode ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.evaluate("window.__nib.store.setPanel('home')")
        page.wait_for_timeout(500)
        shot(page, "toolbox")
        meta["toolbox_panel"] = box(page, "#panel")
        ctx.close()
        ctx, page = start(browser, url, dark=True)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: false, textSize: 16 })")
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.locator("#btn-study").click()
        page.wait_for_timeout(700)
        shot(page, "dark")
        ctx.close()
        browser.close()
    srv.shutdown()
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print("meta keys:", list(meta))


if __name__ == "__main__":
    main()
