"""Extra app captures for the Store marketing slides (annotations, pages).

Run:  npm run build:single && python3 store/marketing/capture.py
Writes store/marketing/frames/*.png (3200x2000). Made-up files only.
"""
import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test"))
from e2e import FIX, NO_PICKER, SAMPLE, SAMPLE_NAME, click_at, drag, open_fixture, serve, tool  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).resolve().parent / "frames"
OUT.mkdir(parents=True, exist_ok=True)


def shot(page, name):
    page.evaluate("document.getElementById('toasts')?.replaceChildren(); window.__nib.store.select(null)")
    page.mouse.move(5, 600)
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / f"{name}.png"))
    print("captured", name)


def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=2, bypass_csp=True)
        ctx.add_init_script(NO_PICKER)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector(".app.ready", timeout=20000)
        page.evaluate("window.__nib.store.setPrefs({ rightOpen: true })")

        # ---- annotations on a report ----
        open_fixture(page, FIX / "report.pdf", "Quarterly report.pdf")
        page.evaluate("window.__nib.store.setPanel('comment')")
        tool(page, "markup")
        page.evaluate("window.__nib.store.setPrefs({ markup: 'highlight' })")
        drag(page, 0, [(0.10, 0.135), (0.5, 0.135)])
        tool(page, "note")
        click_at(page, 0, 0.86, 0.13)
        page.locator(".note-pop textarea").fill("Check the South figures")
        page.locator('.note-pop [data-a="ok"]').click()
        tool(page, "shape")
        page.evaluate("window.__nib.store.setPrefs({ shape: 'ellipse' })")
        drag(page, 0, [(0.715, 0.221), (0.835, 0.251)])
        page.evaluate("window.__nib.store.setPrefs({ shape: 'arrow' })")
        drag(page, 0, [(0.64, 0.36), (0.74, 0.262)])
        tool(page, "text")
        click_at(page, 0, 0.45, 0.37)
        page.keyboard.type("Best margin this quarter")
        page.keyboard.press("Escape")
        tool(page, "stamp")
        click_at(page, 0, 0.75, 0.52)
        tool(page, "hand")
        shot(page, "annotate")

        # ---- pages: merge two files, page manager ----
        page.evaluate("window.__nib.closeDoc(window.__nib.store.doc)")
        open_fixture(page, SAMPLE, SAMPLE_NAME)
        data = base64.b64encode((FIX / "report.pdf").read_bytes()).decode()
        page.evaluate(
            """async (d) => { const b = atob(d); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); await window.__nib.mergeBytes('Quarterly report.pdf', u); }""",
            data,
        )
        page.wait_for_timeout(600)
        page.evaluate("window.__nib.store.setPanel('organize')")
        page.wait_for_timeout(500)
        shot(page, "pages")
        b.close()
    srv.shutdown()


if __name__ == "__main__":
    main()
