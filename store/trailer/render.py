"""Renders the Nib-E trailer to MP4 (and the Store thumbnail).

Run (after capture.py):
  python3 store/trailer/render.py                 # all formats
  python3 store/trailer/render.py 16x9            # one format
  python3 store/trailer/render.py --preview 16x9 3 9.5 20   # PNG frames at those seconds
Output: store/trailer/out/
"""
import functools
import http.server
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)
FPS = 30
SIZES = {"16x9": (1920, 1080), "9x16": (1080, 1920), "4x5": (1080, 1350)}
NAMES = {"16x9": "Nib-E-trailer-16x9-1920x1080.mp4", "9x16": "Nib-E-trailer-9x16-1080x1920.mp4", "4x5": "Nib-E-trailer-4x5-1080x1350.mp4"}


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    h = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def open_page(browser, base, fmt, poster=False):
    w, h = SIZES[fmt]
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/store/trailer/trailer.html?f={fmt}{'&poster=1' if poster else ''}")
    page.wait_for_function("window.ready && window.ready.then && true")
    page.evaluate("window.ready")
    if errors:
        raise RuntimeError(errors)
    return page


def render(browser, base, fmt):
    page = open_page(browser, base, fmt)
    dur = page.evaluate("window.DURATION")
    n = int(round(dur * FPS))
    out = OUT / NAMES[fmt]
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-map", "0:v", "-map", "1:a", "-shortest",
        "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-r", str(FPS), "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "128k",
        str(out),
    ]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    for i in range(n):
        page.evaluate(f"window.renderAt({i / FPS})")
        ff.stdin.write(page.screenshot(type="jpeg", quality=96))
        if i % 150 == 0:
            print(f"{fmt}: frame {i}/{n} ({time.time() - t0:.0f}s)", flush=True)
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    page.close()
    print("wrote", out)


def poster(browser, base):
    page = open_page(browser, base, "16x9", poster=True)
    page.evaluate("window.renderPoster()")
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / "Nib-E-trailer-thumbnail-1920x1080.png"))
    page.close()
    print("wrote thumbnail")


def main():
    args = sys.argv[1:]
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        if args and args[0] == "--preview":
            fmt = args[1]
            page = open_page(browser, base, fmt)
            for s in args[2:]:
                page.evaluate(f"window.renderAt({float(s)})")
                page.screenshot(path=str(OUT / f"preview-{fmt}-{s}.png"))
            print("previews done")
        else:
            if args == ["--poster"]:
                poster(browser, base)
            else:
                for fmt in args or list(SIZES):
                    render(browser, base, fmt)
                if not args or "16x9" in args:
                    poster(browser, base)
        browser.close()
    srv.shutdown()


if __name__ == "__main__":
    main()
