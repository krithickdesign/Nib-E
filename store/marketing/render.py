"""Renders the Microsoft Store marketing slides.

Run (after capture.py, and store/trailer/capture.py for the shared frames):
  python3 store/marketing/render.py
  python3 store/marketing/render.py de     # German only (en de = both; default en)
Output: store/marketing/out/01-…png … 08-…png, German in out/de/…-de.png  (3840x2160, Store maximum)
"""
import functools
import http.server
import re
import shutil
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
NAMES = ["01-all-in-one", "02-fill-forms", "03-sign", "04-annotate", "05-pages", "06-redact", "07-study-mode", "08-every-tool-free"]


SHARED = ["ask", "fill6", "sign10", "sign_done", "study6", "redact2", "redact3", "toolbox"]  # from the trailer capture


def main():
    frames = HERE / "frames"
    for n in SHARED:
        src = ROOT / "store/trailer/frames" / f"{n}.png"
        if not (frames / f"{n}.png").exists():
            if not src.exists():
                raise SystemExit(f"missing {src}: run store/trailer/capture.py first")
            shutil.copy(src, frames / f"{n}.png")
    defs = re.search(r"<defs>(.*?)</defs>", (ROOT / "docs/index.html").read_text(), re.S).group(1)
    (HERE / "slides.html").write_text((HERE / "slides.src.html").read_text().replace("{{DEFS}}", defs))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for lang in sys.argv[1:] or ["en"]:
            out = OUT if lang == "en" else OUT / lang
            out.mkdir(exist_ok=True)
            p = b.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=2)
            p.goto(f"http://127.0.0.1:{srv.server_address[1]}/store/marketing/slides.html?lang={lang}")
            p.evaluate("window.ready")
            p.wait_for_timeout(300)
            for i, name in enumerate(NAMES, 1):
                fname = name if lang == "en" else f"{name}-{lang}"
                p.locator(f"#s{i}").screenshot(path=str(out / f"{fname}.png"))
                print("wrote", fname)
            p.close()
        b.close()
    srv.shutdown()


if __name__ == "__main__":
    main()
