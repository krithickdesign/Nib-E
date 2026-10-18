"""Makes the Microsoft Store package icons from src-tauri/icons/icon.png.

    python3 scripts/msix/make-icons.py

Writes src-tauri/icons/msix/ (commit the result). build-msix.ps1 copies the folder
into the package's Assets.

Windows picks the file for each place by its name:
- Square44x44Logo.targetsize-N[_altform-unplated|_altform-lightunplated].png:
  taskbar, Start list, Alt+Tab, title bar (exact pixel sizes, no plate behind them)
- Square44x44Logo.scale-N / Square150x150Logo.scale-N / StoreLogo.scale-N:
  Start tiles and the Store, per display scaling (100 % to 200 %)
- FileLogo.targetsize-N: the icon of PDF files in File Explorer, up to 256 px
  (a page with the Nib-E badge, so documents don't look like the app itself)
Without the large sizes, Windows draws the 44 px picture small in the middle of
File Explorer's big icon tiles.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src-tauri" / "icons" / "msix"

TARGETS = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]
SCALES = [100, 125, 150, 200]


def app_icon() -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())  # the rounded square without the empty margin


def fit(art: Image.Image, size: int, fill: float) -> Image.Image:
    """`art` scaled to `fill` of a size×size transparent canvas, centred."""
    inner = max(1, round(size * fill))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return canvas


def page_icon(art: Image.Image, size: int) -> Image.Image:
    """A white page with a folded corner and the Nib-E badge, drawn 4× larger and scaled down."""
    s = size * 4
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = round(s * 0.72)
    x0 = round(s * 0.06)
    y0 = round(s * 0.03)
    y1 = round(s * 0.97)
    fold = round(s * 0.2)
    line = max(1, round(s / 64))
    d.polygon([(x0, y0), (x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w, y1), (x0, y1)], fill=(250, 250, 252, 255), outline=(176, 182, 198, 255), width=line)
    d.polygon([(x0 + w - fold, y0), (x0 + w - fold, y0 + fold), (x0 + w, y0 + fold)], fill=(214, 219, 232, 255), outline=(176, 182, 198, 255), width=line)
    for k in range(4):
        y = round(s * (0.26 + k * 0.085))
        right = x0 + round(w * (0.78 if k < 3 else 0.5))
        d.rounded_rectangle([x0 + round(s * 0.09), y, right, y + round(s * 0.03)], radius=round(s * 0.015), fill=(204, 209, 222, 255))
    b = round(s * 0.54)
    im.alpha_composite(art.resize((b, b), Image.LANCZOS), (s - b, s - b))
    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    art = app_icon()

    for n in TARGETS:
        img = fit(art, n, 1.0 if n <= 24 else 0.92)
        for suffix in ("", "_altform-unplated", "_altform-lightunplated"):
            img.save(OUT / f"Square44x44Logo.targetsize-{n}{suffix}.png")
        # PDF files: a page with the badge; at the smallest sizes the badge alone reads better.
        (img if n <= 24 else page_icon(art, n)).save(OUT / f"FileLogo.targetsize-{n}.png")

    for pct in SCALES:
        f = pct / 100
        fit(art, round(44 * f), 1.0).save(OUT / f"Square44x44Logo.scale-{pct}.png")
        fit(art, round(150 * f), 0.907).save(OUT / f"Square150x150Logo.scale-{pct}.png")
        fit(art, round(50 * f), 1.0).save(OUT / f"StoreLogo.scale-{pct}.png")
        page_icon(art, round(44 * f)).save(OUT / f"FileLogo.scale-{pct}.png")

    print(f"{len(list(OUT.glob('*.png')))} icons in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
