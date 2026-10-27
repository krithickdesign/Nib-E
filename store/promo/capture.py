"""Captures real Nib-E footage for the "We listened" promo (features from user feedback).

Run:  npm run build:single && node scripts/copy-ocr.mjs dist-single && python3 store/promo/capture.py
Writes store/promo/frames/*.png (3200x2000) and frames/meta.json with the
rectangles and points (image pixels) the promo's camera and cursor use.
Uses only the made-up files in test/fixtures.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test"))

from e2e import FIX, NO_PICKER, SAMPLE, SAMPLE_NAME, bring, click_at, open_fixture, paper, serve, tool  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).resolve().parent / "frames"
OUT.mkdir(parents=True, exist_ok=True)
W, H, S = 1600, 1000, 2
A4W, A4H = 595.28, 841.89
meta = {"size": [W * S, H * S]}


def shot(page, name, keep_toasts=False):
    if not keep_toasts:
        page.evaluate("document.getElementById('toasts')?.replaceChildren()")
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / f"{name}.png"))
    print("captured", name)


def deselect(page):
    page.evaluate("window.__nib.store.select(null)")
    page.wait_for_timeout(150)


def bb(page, loc):
    b = (page.locator(loc).first if isinstance(loc, str) else loc).bounding_box()
    return [round(b["x"] * S), round(b["y"] * S), round(b["width"] * S), round(b["height"] * S)]


def center(page, loc):
    x, y, w, h = bb(page, loc)
    return [x + w // 2, y + h // 2]


def union(rects, pad=0):
    x0 = min(r[0] for r in rects) - pad
    y0 = min(r[1] for r in rects) - pad
    x1 = max(r[0] + r[2] for r in rects) + pad
    y1 = max(r[1] + r[3] for r in rects) + pad
    return [x0, y0, x1 - x0, y1 - y0]


def start(browser, url, locale="en-US"):
    ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=S, bypass_csp=True, locale=locale)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    ctx.add_init_script(NO_PICKER)
    page = ctx.new_page()
    page.goto(url)
    page.wait_for_selector(".app.ready", timeout=20000)
    return ctx, page


def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ---- 1. edit existing text ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, FIX / "retype.pdf", "Invoice 2026-114.pdf")
        page.evaluate("window.__nib.store.setPanel('edit')")
        tool(page, "retype")
        bring(page, 0, 0.18)
        pb = paper(page, 0).bounding_box()
        P = lambda x, y: [round((pb["x"] + x / A4W * pb["width"]) * S), round((pb["y"] + y / A4H * pb["height"]) * S)]
        shot(page, "edit0")
        meta["edit_line"] = P(150, 145)
        meta["edit_rect"] = P(30, 95) + [0, 0]
        br = P(560, 245)
        meta["edit_rect"] = [meta["edit_rect"][0], meta["edit_rect"][1], br[0] - meta["edit_rect"][0], br[1] - meta["edit_rect"][1]]
        page.mouse.click(pb["x"] + 150 / A4W * pb["width"], pb["y"] + 145 / A4H * pb["height"])
        page.wait_for_timeout(300)
        shot(page, "edit1")
        ta = page.locator("textarea.text-editor")
        ta.fill("")
        typed = "Amount due: 2,500.00 EUR"
        for k, n in enumerate([12, 16, 20, len(typed)]):
            ta.fill(typed[:n])
            shot(page, f"edit2_{k}")
        page.keyboard.press("Escape")
        tool(page, "hand")
        deselect(page)
        page.mouse.move(5, 500)
        shot(page, "edit3")
        ctx.close()

        # ---- 2. text recognition, then select + copy ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, FIX / "scan.pdf", "Scanned worksheet.pdf")
        page.evaluate("window.__nib.store.setPanel('ocr')")
        page.wait_for_selector('[data-act="ocr-run"]', timeout=10000)
        bring(page, 0, 0.2)
        shot(page, "ocr0")
        meta["ocr_run"] = center(page, '[data-act="ocr-run"]')
        page.click('[data-act="ocr-run"]')
        page.wait_for_selector("#panel-body .callout.ok", timeout=180000)
        page.wait_for_timeout(300)
        shot(page, "ocr1")
        meta["ocr_panel"] = bb(page, "#panel")
        tool(page, "select")
        bring(page, 0, 0.2)
        pb = paper(page, 0).bounding_box()
        a = (pb["x"] + 0.1 * pb["width"], pb["y"] + 0.076 * pb["height"])
        b = (pb["x"] + 0.88 * pb["width"], pb["y"] + 0.2 * pb["height"])
        meta["sel_from"] = [round(a[0] * S), round(a[1] * S)]
        meta["sel_to"] = [round(b[0] * S), round(b[1] * S)]
        page.mouse.move(*a)
        page.mouse.down()
        steps = 4
        for k in range(1, steps + 1):
            u = k / steps
            page.mouse.move(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, steps=4)
            shot(page, f"sel{k}")
        page.mouse.up()
        page.wait_for_timeout(200)
        rects = page.locator(".tsel-rect")
        meta["sel_rect"] = union([bb(page, rects.nth(i)) for i in range(rects.count())], 40)
        meta["sel_copy"] = center(page, ".tsel-copy")
        page.mouse.move(5, 500)
        shot(page, "sel_done")
        page.locator(".tsel-copy").click()
        page.wait_for_timeout(300)
        meta["sel_clip"] = page.evaluate("navigator.clipboard.readText()")
        shot(page, "sel_copied", keep_toasts=True)
        ctx.close()

        # ---- 3. form fields of every kind ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: false })")
        open_fixture(page, FIX / "form-fields.pdf", "Application form.pdf")
        page.wait_for_timeout(600)
        tool(page, "hand")
        fld = lambda t, i=0: page.locator(f'#pages .layer-forms > [title="{t}"]').nth(i)
        page.mouse.move(5, 500)
        shot(page, "form0")
        meta["form_page"] = bb(page, paper(page, 0))
        meta["f_name"] = center(page, fld("FullName"))
        meta["f_id"] = center(page, fld("ID"))
        meta["f_id_rect"] = bb(page, fld("ID"))
        meta["f_name_rect"] = bb(page, fld("FullName"))
        fld("FullName").click()
        page.keyboard.type("Jamie Rivera")
        shot(page, "form1")
        page.keyboard.press("Tab")
        page.wait_for_timeout(900)
        for k, part in enumerate(["1234", "567"]):
            page.keyboard.type(part)
            shot(page, f"form2_{k}")
        # last digits, then Enter: a full comb box that still has focus scrolls by half a cell (app bug, see notes)
        page.keyboard.type("890")
        page.keyboard.press("Enter")
        page.wait_for_timeout(800)
        page.mouse.move(5, 500)
        shot(page, "form2_2")
        meta["f_female"] = center(page, fld("Gender", 1))
        meta["f_married"] = center(page, fld("Married"))
        fld("Gender", 1).click()
        page.wait_for_timeout(600)
        page.mouse.move(5, 500)
        shot(page, "form2_3")
        fld("Married").click()
        page.wait_for_timeout(600)
        meta["f_city"] = center(page, fld("City"))
        meta["f_city_rect"] = bb(page, fld("City"))
        # the open dropdown list is a system menu (not in screenshots); promo.html draws it from these options
        meta["f_city_opts"] = [o.strip() for o in fld("City").locator("select option").all_inner_texts() if o.strip()]
        page.mouse.move(5, 500)
        shot(page, "form3")
        fld("City").locator("select").select_option(label="Paris")
        page.wait_for_timeout(700)
        page.mouse.move(5, 500)
        shot(page, "form4")
        lang = page.locator('#pages .layer-forms > [title^="Language"]')
        meta["f_lang_rect"] = bb(page, lang)
        rows = lang.locator(".field-row")
        meta["f_lang_rows"] = [center(page, rows.nth(i)) for i in range(rows.count())]
        rows.nth(1).click()
        page.wait_for_timeout(700)
        page.mouse.move(5, 500)
        shot(page, "form4b")
        page.locator('#pages .layer-forms > [title^="Language"] .field-row').nth(2).click()
        page.wait_for_timeout(700)
        page.mouse.move(5, 500)
        shot(page, "form5")
        meta["f_notes"] = center(page, fld("Notes"))
        meta["f_notes_rect"] = bb(page, fld("Notes"))
        fld("Notes").click()
        page.keyboard.type("Available from May")
        page.keyboard.press("Enter")
        page.keyboard.type("Prefers email")
        page.wait_for_timeout(300)
        shot(page, "form6")
        page.mouse.click(1500, 950)
        page.wait_for_timeout(900)
        page.mouse.move(5, 500)
        shot(page, "form7")
        ctx.close()

        # ---- 4. page layout next to the zoom ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: false, spread: 'single' })")
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.wait_for_timeout(500)
        tool(page, "hand")
        page.wait_for_timeout(300)
        page.mouse.move(5, 500)
        shot(page, "lay0")
        meta["lay_btn"] = center(page, ".dock-layout")
        meta["lay_dock"] = bb(page, "#dock")
        page.locator(".dock-layout").click()
        page.wait_for_timeout(700)
        page.mouse.move(5, 500)
        shot(page, "lay1")
        page.locator(".dock-layout").click()
        page.wait_for_timeout(700)
        page.mouse.move(5, 500)
        shot(page, "lay2")
        ctx.close()

        # ---- 5. digital signatures + certificate signing ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, FIX / "signed.pdf", "Contract (signed).pdf")
        page.evaluate("window.__nib.store.setPanel('signatures')")
        page.wait_for_selector(".sig-row", timeout=15000)
        page.wait_for_timeout(300)
        shot(page, "sig0")
        meta["sig_panel"] = bb(page, "#panel")
        meta["sig_rows"] = union([bb(page, page.locator(".sig-row").nth(i)) for i in range(page.locator(".sig-row").count())], 30)
        with page.expect_file_chooser() as fc:
            page.click('[data-act="sig-pick"]')
        fc.value.set_files(str(FIX / "test-only-cert.p12"))
        page.wait_for_timeout(300)
        page.fill("#pf-sigpw", "test")
        page.wait_for_timeout(200)
        shot(page, "sig1")
        meta["sig_sign"] = center(page, '[data-act="sig-sign"]')
        page.click('[data-act="sig-sign"]')
        page.get_by_role("button", name="Sign and save", exact=True).wait_for(timeout=10000)
        page.wait_for_timeout(300)
        shot(page, "sig2")
        meta["sig_modal"] = bb(page, "#modal .modal-card, #modal > *")
        ctx.close()

        # ---- 6. print check ----
        ctx, page = start(browser, url)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, FIX / "report.pdf", "Poster draft.pdf")
        page.evaluate("window.__nib.store.setPanel('printcheck')")
        page.click('[data-act="print-run"]')
        page.wait_for_selector("#panel-body .findings", timeout=15000)
        page.wait_for_timeout(300)
        shot(page, "print0")
        meta["print_panel"] = bb(page, "#panel")
        ctx.close()

        # ---- 7. German interface ----
        ctx, page = start(browser, url, locale="de-DE")
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        open_fixture(page, SAMPLE, "Arbeitsblatt Wärmeübertragung.pdf")
        page.evaluate("window.__nib.store.setPanel('home')")
        page.wait_for_timeout(600)
        shot(page, "lang_de")
        ctx.close()
        browser.close()
    srv.shutdown()
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print("meta:", json.dumps(meta)[:600])


if __name__ == "__main__":
    main()
