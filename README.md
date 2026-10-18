# Nib-E · the all-in-one PDF editor

Part of the Desk-E family. Published as Axiomate Technologies.

Fill forms, sign, write and draw, redact, organise pages and study, in your browser or as an app.
**Every feature free:** no paywalls, no Pro plan, no account. And your files never leave your device.

[▶ Watch Nib-E in 47 seconds](docs/assets/nib-e-trailer.mp4)

![Nib-E filling in a form](docs/assets/fill.webp)

> Nib-E is young and growing. Found something odd? Please [report it](TESTING.md).

## Use it

- **Windows:** the **Microsoft Store** (no warning, automatic updates; link on the website once live).
- **Desktop installers (Windows, macOS, Linux):** download from the project's **Releases** page.
  They are not signed yet, so the first start shows a warning:
  Windows → *More info* → *Run anyway*; macOS → *System Settings → Privacy & Security* → *Open Anyway*.
- **On the web:** open the project's GitHub Pages site and click **Open Nib-E**
  (`https://<user>.github.io/<repo>/`, once Pages is switched on, see below). Works on phones and tablets too.
- **Single file, no install:** download `docs/app/index.html`, rename it `Nib-E.html` if you like, and double-click it.

## Privacy

- **Network: none.** The desktop app has no internet permission (no network code, strict security rules).
  The web version's security rules (CSP) block every connection to other websites once the page is loaded;
  only Text recognition loads its own files (`ocr/`) from the same site.
- Opening, editing and saving all run on your device (PDFium as WebAssembly). Nothing is sent anywhere.
- No account, no analytics, no cookies, no third-party requests (fonts are bundled). No update checks.
- No AI features. A separate, opt-in AI editor may come later as its own product; Nib-E itself stays offline.
- Kept on this device only: settings, a signature you chose to remember, stamps, study notes,
  unsaved-work copies (crash recovery) and the previous version of files you saved over.
  *Toolbox → Settings → Forget everything* removes them.
- The desktop app can read and write only files you picked (Open/Save window, drag and drop, "Open with").
- **Safe mode:** scripts inside PDFs never run; links, launch actions and attachments can't open anything by themselves.

## Features

| Area | What it does |
|---|---|
| **Tabs** | Several PDFs open at once (up to 8). Double-click the file name to rename (renames the file on disk in the desktop app, and in Chrome / Edge where supported). Asks before closing unsaved work; offers unsaved work back after a crash. |
| **Save** | Save writes over the opened file (desktop app, Chrome, Edge), keeps the earlier version (restorable). Save menu: Save as, Export (with notes, flattened, notes only, images, text), Print. |
| **Fill forms** | Real form fields (text, boxes for single characters, checkboxes, radio buttons, dropdowns, multi-choice lists, multi-line text, Reset buttons; the Text, Select and Hand tools all fill them), *and* forms without fields: Nib-E finds boxes, lines and tick boxes and asks whether to make them fillable. Text uses the form's font and size; `Tab` jumps to the next box. Works alongside real fields in the same file. |
| **Select text** | Select tool: drag across the PDF's text, Ctrl+C or Copy; double-click a word, triple-click a line, Ctrl+A the page. |
| **Edit text** | Edit existing text: click a line of the PDF, type the new text. Saving removes the old characters and writes the new line in the PDF's own font (if it has every character) or the closest included font, same size, colour and alignment. |
| **Sign** | Handwritten: draw once, place anywhere, optionally remembered on this device. Certificate: sign with your own .p12/.pfx (RSA, SHA-256, visible or invisible). |
| **Check signatures** | Every signature in a PDF checked offline (hash, signature value, certificate chain in the file): Intact / Changed after / Not valid. No trust-list or revocation check. |
| **Text recognition** | OCR (Tesseract, English and German) adds an invisible text layer to scanned pages, also rotated ones. |
| **Print check** | Fonts not embedded, image resolution at printed size, colour spaces, trim and bleed, transparency, page sizes. |
| **Draw and write** | Pen and highlighter (stylus pressure, palm rejection, pen feel Precise / Balanced / Smooth), text boxes with font toolbar (six included font families, alignment, mouse-wheel picking) and spelling check. Copy, paste and duplicate (Ctrl+C / V / D). |
| **Toolbox** | Grouped into Write (Content editor, Form filling & signature, Form builder, Annotations, Stamp library), Pages (Page manager, File merger, Size reducer, Attachments), Protect (PDF redaction, Password lock, Digital signatures, Safety report), Convert (Image export, Text recognition, Print check, Image to PDF) and Study. |
| **Study mode** | PDF beside a notebook; note pages lined, grid or blank. Notes kept on the device as you write and restored (with the last page) when the book is opened again; or written into the book file. Library on the start screen, `.nibe` backup. |
| **Comments** | Sticky notes, highlight / underline / strike text, shapes, links, header and footer, watermark. |
| **Stamps** | Ready-made stamps, your own text, a **stamp designer** (drag-and-drop text, shapes, logo, date), or any PNG. Saved in the browser. |
| **Redact** | Removes text and erases picture pixels under the marks, optional removal of hidden data, then verifies nothing is left. |
| **Pages and files** | Insert, rotate, reorder, delete, extract; combine PDFs and images; compress; password (AES-256); export pages as images. |
| **View** | One page, two pages, or two pages with a title page (button next to the zoom); zoom slider, fit width / page; Page Down / Up, arrow keys and page-turn pedals. |
| **Languages** | English, German, Spanish, French, Portuguese (Brazil), Italian (Settings → Language, follows the system by default). |
| **Comfort** | Interface size 100–200 % (default 150 %; phones 100 %), light/dark theme, full-page reading, keyboard shortcuts, Help tour. Phone layout: bottom tool bar, tools sheet, PDF/Notes tabs, two-finger scroll while writing. |

## Website: published automatically (maintainers)

Every push to `main` rebuilds the web app from the source and publishes the site
(`.github/workflows/pages.yml`). Nothing to build by hand.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is at `https://<user>.github.io/<repo>/`, the app at `…/app/`.
Before sharing the site publicly, fill in your details in `docs/legal.html` (Impressum);
the website build shows a warning until you do.

## Release a new desktop version (maintainers)

1. **Actions → Release → Run workflow**, type the new version (three numbers, e.g. `0.5.1`).
2. Wait 15–25 minutes. The workflow sets the version everywhere, builds Windows, macOS and
   Linux installers, adds `SHA256SUMS.txt` (fingerprints) and **publishes the release** once
   every build succeeded. If one build fails, nothing is published: fix it and run again with the same number.
3. Installed apps don't update themselves: people install the new version over the old one
   (settings and study notes are kept). The website updates by itself.

The version lives in one place, `package.json` (`"version"`).
`npm run version:set 0.5.2` changes it locally (package files, Rust, website footer).

The publisher name also lives in `package.json` (`"nibPublisher"`, now the placeholder
"Axiomate Technologies"). `npm run publisher:set -- "New Name"` changes it in the app,
installers and website; change it in Partner Center and the `MSIX_PUBLISHER_NAME` variable too.

**Microsoft Store:** see [STORE.md](STORE.md). Once the Store identity is set up, every
Release also makes the Store edition package. Listing texts and screenshots: `store/`.
Retake screenshots after UI changes: `npm run build:single && python3 scripts/screenshots.py`.

Build on your own computer (needs [Rust](https://rustup.rs) and, on Linux, `libwebkit2gtk-4.1-dev`):

```
npm install
npm run desktop        # installers in src-tauri/target/release/bundle/
npm run desktop:dev    # app window with live reload
```

## Develop

Needs Node.js 20+.

```
npm install
npm run dev          # local dev server
npm run typecheck
npm run pages        # build the single-file app into docs/app/ (done automatically on GitHub)
npm test             # pen-feel check + 150+ browser checks (Python + Playwright + pikepdf + pdfplumber + poppler)
```

```
src/
  main.ts            start-up, tabs, layout, save/print wiring, recovery, desktop events
  store.ts           open documents (tabs) + per-tab undo/redo
  doc.ts             open, merge, detect; redact / compress / protect / export
  saving.ts          Save (in place, verified, backup), Save as, Export, Print
  library.ts         study library, crash recovery, autosave
  persist.ts         edits to plain data and back
  platform/          files (Open/Save windows, desktop commands), IndexedDB, environment
  pdf/               PDFium helpers, form-box detection, text layer, PDF writer, redaction, nibdata (notes in the file)
  ui/                viewer, tools panel, dock, save menu, library, help tour, stamp designer, spelling
src-tauri/           desktop app (Rust): file commands, Open/Save windows, single instance, security rules
docs/                GitHub Pages site (landing page + app)
test/                end-to-end checks, pen-feel check, fixtures
```

Design: edits are kept as a plan on top of the opened file; Save builds a new PDF from it and (where possible) writes it over the file, after checking it.

## Known limits

- Editing the PDF's own text works one line at a time; text doesn't reflow into the next line. On screen the closest included font is shown; the saved file uses the PDF's own font when it has every character.
- Standard PDF fonts (Helvetica, Times, Courier) only store Western European characters; choose an included font (e.g. Noto Sans) for other scripts.
- Certificate signing: RSA certificates only; signing saves a new copy (signatures already in the file stop being valid there). Signature checks don't use trust lists or revocation.
- Text recognition: English and German; the single offline file (`Nib-E.html`) has no recognition files (use the desktop app or the website).
- Adobe XFA forms and DRM-protected PDFs can't be shown; Nib-E says so.
- Interface translations are new; some messages are still English.
- Spelling uses the browser's own checker and only for text you type.
- Very large PDFs can stutter while pages render.
- Saving changes to a digitally signed PDF invalidates its signature (Nib-E warns first).
- Firefox and Safari have no Save window for web pages: files go to Downloads (or wherever the browser asks). Use Chrome, Edge or the desktop app to save over files.
- Study notes kept "on this device" live in the browser's or app's storage: back them up (.nibe) before clearing site data or changing computers.
- Print sends pages as images (150 dpi): fine for reading, not for professional print jobs.
- Phone layout is tested in a phone-sized browser only, not yet on real phones.
- GitHub installers are unsigned (first-start warning); the Microsoft Store version is signed by Microsoft. The desktop app was test-run on Linux; Windows and macOS builds come from GitHub Actions and need real-device testing.

## Licences

Nib-E is **MIT licensed** (see [LICENSE](LICENSE)). Desktop app: Tauri (MIT / Apache-2.0).
Third-party parts: PDFium (BSD-3 / Apache-2.0), EmbedPDF (MIT), pdf-lib (MIT), fflate (MIT),
perfect-freehand (MIT), node-forge (BSD-3 / GPL-2.0 dual, used under BSD-3), Tesseract, tesseract.js and
tessdata_best (Apache-2.0), fonts via Fontsource and `src/assets/fonts` (SIL OFL 1.1, see LICENSES.md there).
