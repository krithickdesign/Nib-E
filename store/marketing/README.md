# Microsoft Store marketing screenshots

Eight 3840×2160 slides (headline + real app footage) for the Store listing.
Upload them in this order; the first one is the picture shown in Store search results.

```
npm run build:single
python3 store/trailer/capture.py     # shared frames (form, sign, study, redaction)
python3 store/marketing/capture.py   # annotations + page manager frames
python3 store/marketing/render.py en de   # → out/01…08.png and out/de/01…08-de.png
```

- Text and layout: `slides.src.html` (icons are taken from `docs/index.html` at render time).
- German: the `DE` and `DE_TOOLS` tables in `slides.src.html`; the app footage stays English.
- Only the made-up files in `test/fixtures` are used. No personal data.
- `frames/*.png`, `out/` and `slides.html` are generated and not committed.
