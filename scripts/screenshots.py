"""Takes the website pictures and the Microsoft Store screenshots from the real app.

Run:  npm run build:single && python3 scripts/screenshots.py
Writes:
  docs/assets/fill.webp, ask.webp, study.webp     (website, 3200x2000)
  store/screenshots/01-…png … 05-…png             (Store listing, 1920x1080)
Uses only the made-up test files in test/fixtures (no personal data).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "test"))

from e2e import FIX, NO_PICKER, SAMPLE, SAMPLE_NAME, click_at, drag, make_fillable, open_fixture, serve, tool  # noqa: E402
from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SITE = ROOT / "docs" / "assets"
STORE = ROOT / "store" / "screenshots"
STORE.mkdir(parents=True, exist_ok=True)


def webp(png: Path, out: Path) -> None:
    Image.open(png).convert("RGB").save(out, "WEBP", quality=82, method=6)
    png.unlink()


def shot(page, path):
    page.evaluate("document.getElementById('toasts')?.replaceChildren()")
    page.wait_for_timeout(150)
    page.screenshot(path=str(path))


def start(browser, url, w, h, scale, dark=False):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale, bypass_csp=True, color_scheme="dark" if dark else "light")
    ctx.add_init_script(NO_PICKER)
    page = ctx.new_page()
    page.goto(url)
    page.wait_for_selector(".app.ready", timeout=20000)
    return ctx, page


def fill_form(page, shoot_ask=None):
    open_fixture(page, FIX / "form.pdf", "Membership form.pdf")
    page.wait_for_timeout(900)
    if shoot_ask:
        shoot_ask()
    make_fillable(page)
    hot = page.locator("#pages .sheet").nth(0).locator(".hot-text")
    hot.nth(0).click()
    for i, s in enumerate(["Hartmann", "Anna", "14.03.1999", "Regensburg", "A. Hartmann"]):
        page.keyboard.type(s)
        page.keyboard.press("Enter" if i == 1 else "Tab")
        page.wait_for_timeout(120)
    page.keyboard.press("Escape")
    radios = page.locator("#pages .sheet").nth(0).locator(".hot-radio")
    radios.nth(1).click()
    page.locator("#pages .sheet").nth(0).locator(".hot-check").nth(1).click()
    page.mouse.click(5, 5)
    page.wait_for_timeout(400)


def study(page):
    open_fixture(page, SAMPLE, SAMPLE_NAME)
    page.evaluate("window.__nib.store.setPrefs({ rightOpen: false, textSize: 16 })")
    page.locator("#btn-study").click()
    page.wait_for_timeout(600)
    tool(page, "pen")
    # A small sketch: temperature falling through a wall, plus arrows.
    nb = dict(root="#nb-pages", scroller="#nb-viewer")
    drag(page, 0, [(0.14, 0.22), (0.14, 0.42), (0.52, 0.42)], **nb)
    drag(page, 0, [(0.16, 0.25), (0.26, 0.29), (0.36, 0.34), (0.48, 0.39)], **nb, steps=10)
    drag(page, 0, [(0.30, 0.20), (0.30, 0.44)], **nb)
    drag(page, 0, [(0.58, 0.30), (0.76, 0.30)], **nb)
    drag(page, 0, [(0.72, 0.27), (0.76, 0.30), (0.72, 0.33)], **nb)
    tool(page, "text")
    click_at(page, 0, 0.14, 0.10, **nb)
    page.keyboard.type("Fourier: q = -k · dT/dx")
    page.keyboard.press("Escape")
    click_at(page, 0, 0.56, 0.36, **nb)
    page.keyboard.type("heat flows hot → cold")
    page.keyboard.press("Escape")
    tool(page, "highlighter")
    drag(page, 0, [(0.12, 0.30), (0.55, 0.30)])
    tool(page, "hand")
    page.mouse.click(5, 5)
    page.wait_for_timeout(500)


def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ---- website (1600x1000 at 2x = 3200x2000) ----
        ctx, page = start(browser, url, 1600, 1000, 2)
        fill_form(page, lambda: (shot(page, SITE / "ask.png"), webp(SITE / "ask.png", SITE / "ask.webp")))
        shot(page, SITE / "fill.png")
        webp(SITE / "fill.png", SITE / "fill.webp")
        ctx.close()
        ctx, page = start(browser, url, 1600, 1000, 2)
        study(page)
        shot(page, SITE / "study.png")
        webp(SITE / "study.png", SITE / "study.webp")
        ctx.close()

        # ---- Microsoft Store (1920x1080) ----
        def store_page(dark=False):
            return start(browser, url, 1600, 900, 1.2, dark)

        ctx, page = store_page()
        fill_form(page)
        shot(page, STORE / "01-fill-forms.png")
        ctx.close()

        ctx, page = store_page()
        study(page)
        shot(page, STORE / "02-study-mode.png")
        ctx.close()

        ctx, page = store_page()
        open_fixture(page, FIX / "report.pdf", "Quarterly report.pdf")
        page.evaluate("window.__nib.store.setPanel('redact')")
        page.locator("#pf-find").fill("South")
        page.locator('#panel-body [data-act="find-mark"]').click()
        tool(page, "redact")
        drag(page, 0, [(0.08, 0.005), (0.6, 0.11)])
        tool(page, "hand")
        page.wait_for_timeout(400)
        shot(page, STORE / "03-redaction.png")
        ctx.close()

        ctx, page = store_page()
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        page.evaluate("window.__nib.store.setPanel('home')")
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")
        page.wait_for_timeout(400)
        shot(page, STORE / "04-toolbox.png")
        ctx.close()

        ctx, page = store_page(dark=True)
        fill_form(page)
        shot(page, STORE / "05-dark-mode.png")
        ctx.close()

        browser.close()
    srv.shutdown()
    for p in sorted(STORE.glob("*.png")):
        print(p.relative_to(ROOT), Image.open(p).size)
    for p in sorted(SITE.glob("*.webp")):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
