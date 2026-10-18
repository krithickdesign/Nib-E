# Changelog

## 0.6.0

**New**
- Edit existing text (Content editor → Edit existing text): click a line of the PDF's own text and type. Saving removes the old characters (same technique as redaction) and writes the new line in the PDF's own font when it has every character, else in the closest included font; size, colour, bold/italic and alignment are read from the line. Line-level; on screen the closest font is shown.
- Digital signatures (Toolbox → Protect → Digital signatures): checks every signature in a PDF offline (document hash, signature value, certificate chain inside the file; RSA, RSA-PSS and ECDSA; CMS/PAdES and timestamps) and shows Intact / Changed after / Not valid. Trust lists and revocation are not checked (needs the internet) and the panel says so.
- Certificate signing with your own .p12/.pfx (RSA): visible box (bottom right, bottom left, top right) or invisible, reason and place, SHA-256 detached CMS. Saves a signed copy; signatures already in the file stop being valid in that copy (warned). Tested with pdfsig and pyHanko.
- Text recognition (OCR, Tesseract, English and German): adds an invisible text layer to scanned pages, also on rotated pages. Runs on the device; the recognition files ship with the desktop app and are served from the website's own folder for the web app.
- Print check (Toolbox → Convert): fonts not embedded, image resolution at printed size, image colour spaces, trim and bleed boxes, transparency, page sizes.
- Two-page view and two pages with a title page; zoom slider with Fit width / Fit page (click the zoom number). Page Down / Page Up, arrow keys and page-turn pedals turn pages.
- Six bundled font families (Inter, Noto Sans, Roboto Condensed, Source Serif, Playfair Display, Caveat) with full Unicode, embedded when saving. Hover over the font or size menu and turn the mouse wheel to change it (Settings → Typing).
- Copy, cut, paste and duplicate added items (Ctrl+C / X / V / D, duplicate button); text alignment left / centre / right.
- Attachments panel (open attached PDFs, save other files after a warning); PDF portfolios open the panel automatically.
- Interface languages: German, Spanish, French, Portuguese (Brazil), Italian (Settings → Language; follows the system by default). Some messages are still English.
- Rate Nib-E in the help menu (Microsoft Store edition).
- Flathub files (`flatpak/`), Store listing texts for Spanish, French, Portuguese and Italian.

**Microsoft Store**
- Icons in every size Windows asks for (up to 256 px): PDF files in File Explorer get their own large icon (a page with the Nib-E badge) instead of a small app icon in the middle of the tile; sharper taskbar, Start and Alt+Tab icons. Made by `scripts/msix/make-icons.py`.
- The Store package declares all six languages, so the Store lists them.

**Changed**
- Settings, Image to PDF and Study mode work before a PDF is open; other tools are greyed out with "Open a PDF to use this".
- "Signature" in Form filling is now "Handwritten signature", with a pointer to Digital signatures.
- Clear messages for Adobe XFA forms, PDF portfolios, DRM/certificate-protected and damaged files.
- Web app security rules allow loading files from the app's own site (for Text recognition); other websites stay blocked.
- Desktop: the PDF engine is a separate file next to the page, so the app starts faster.
- fflate 0.8.3 (fixes a possible endless loop on damaged ZIP files).

**Fixed**
- Linux: the AppImage could crash at start (core dump) or take very long on some graphics drivers. Nib-E now starts WebKitGTK without the DMA-BUF renderer, and after a crashed start it switches to software drawing by itself (also forced with `NIB_SAFE_GRAPHICS=1`). The release build now starts the Linux app once on a virtual screen and stops if it crashes.

## 0.5.1

**Microsoft Store**
- Store edition: built with each release (once the Store identity is set up). It has no "Get the latest version" link, because the Store installs updates; Settings and About say "Microsoft Store edition".
- Store package fixes: no wide-tile requirement (310×310 tile removed), artifact contains the unpacked files and `test-local.ps1` to try the Store edition on your own PC before uploading.
- Store listing texts (English, German), age-rating answers and runFullTrust explanation in `store/STORE-LISTING.md`; five 1920×1080 screenshots in `store/screenshots/` (made by `scripts/screenshots.py` from the real app with made-up files).
- Website: "Get Nib-E from the Microsoft Store" becomes the main Windows button once the GitHub variable `MS_STORE_ID` is set; the GitHub installer moves below it. Release notes link the Store too.
- Privacy page: Microsoft Store section and publisher note.

**Changed**
- Toolbox is a plain list grouped into Write, Pages, Protect, Convert, Study and App, with one-colour icons instead of coloured tiles.
- Tool names: Content editor, Form filling & signature, Form builder, Annotations, Stamp library, PDF redaction, Page manager, File merger, Size reducer, Password lock, Image export, Image to PDF, Safety report. Planned tools: Text recognition, Office conversion, Version diff, Measuring tool, Certificate signing.
- Study note backups are `.nibe` files (`.nib` is an Apple developer file type). Older `.nib` backups still open.
- "Beta" removed from the app, the website headings and release titles. Version numbers are plain (0.5.1).
- Published as "Axiomate Technologies" (placeholder name, one command to change: `npm run publisher:set -- "Name"`). Shown in About, the website footer, installer details and the legal page.
- Website pictures retaken with the new names.

**Fixed**
- Release workflow: the final "publish" step found no installers ("no assets to download") because the hidden draft release was looked up by its tag, which drafts don't have yet. Every step now uses the release id; the installers are built with `tauri build` and uploaded by the workflow itself (no third-party upload action), a missing upload stops the run with a clear message, and a failed run of the same version cleans up its old draft.
- Releases are published as "latest", so the website's download links (`/releases/latest`) work. GitHub leaves pre-releases out of that link.

## 0.5.0-beta

**Publishing**
- Website builds and publishes itself on every push (GitHub Actions); the built app is no longer stored in the repository.
- One-button releases: Actions → Release → enter a version → installers for Windows, macOS and Linux with SHA-256 fingerprints, published when all builds succeed. The version lives only in `package.json`.
- Microsoft Store package (MSIX) built with each release once the Store identity is set (see STORE.md).
- SECURITY.md (private security reports), legal notice and privacy page template (`docs/legal.html`).
- Download page: illustrated two-click guide for the Windows first-start warning.

**Changed**
- Tool names in Nib-E's own words (Toolbox, Fill in & sign, Make a fillable form, Black out (redact), Pages, Merge files…); "not affiliated" note in About and on the website.
- Warning next to "Turn redacted pages into images" while that option is being investigated.

**Fixed (safety)**
- A redacted page could be saved with a damaged picture (reported: the page showed garbage or nothing in other readers). Nib-E now checks every JPEG picture it writes (structure and decoding) during redaction and before every Save; a damaged result is never written, the original stays unchanged, and a clear message appears. A redaction picture that comes out damaged is encoded again, or stored as PNG. Files that were already damaged when opened can still be saved.

**New**
- **Nib-E**: new name, part of the Desk-E family (file names, app name, website). Saved data from 0.4 is kept.
- **Help menu** (top right): Help and tour, Keyboard shortcuts, What's new, Send feedback, Privacy and safe mode, About.
- **Send feedback**: choose Something broke / Confusing / Idea / General opinion, describe it, optionally add technical details (version, browser, system; never files). Opens the project's GitHub issue form filled in, or copies the text. Nib-E itself sends nothing.
- **Light / dark switch**: Settings → Appearance (Automatic, Light, Dark).
- **Logo opens the Nib-E home page** (the website landing page) in a new tab. The desktop app and the offline single file have no home page, so there it opens a new Nib-E window or tab.

- **Feedback and survey** go to the Google feedback form (Help → Send feedback copies your text and opens the form; Help → Take the survey). No account needed.

**Changed**
- Website: download warnings in a clearly visible box.
- Desktop app: closing one window no longer closes the others; dropped files open in the window they were dropped on.


## 0.4.0-beta

**New**
- **Desktop app** (Windows, macOS, Linux) built with Tauri. No network permission at all; files are read and written only when you pick them (Open/Save window, drag and drop, "Open with Nib"). Opens PDFs from the file manager, keeps one window, asks before closing unsaved work. Installers are built by GitHub Actions (`.github/workflows/desktop.yml`); they are unsigned, the download page explains the first-start warning.
- **Save menu** (arrow next to Save): Save, Save as, Export (PDF with my notes, flattened PDF, only my notes, pages as images, text), Print, Restore earlier version.
- **Save writes over the opened file** (desktop app, Chrome, Edge) instead of making a copy. The new version is checked before it replaces the old one, and the previous version is kept (one per file, can be turned off in Settings) and can be restored from the Save menu. Signed PDFs warn before saving over them.
- **Save window instead of Downloads**: Open and Save use the system windows where the browser has them. Firefox and Safari still download; Nib explains how to choose a folder there.
- **Print** with page range, with or without your marks and note pages.
- **Study library**: in study mode your marks and notes are kept on this device as you write; the book file is not touched. Opening the same book again restores everything and jumps to the page where you stopped. "Continue studying" list on the start screen, notes backup (.nib) for other devices.
- **Write notes into the book** (study option): Save puts marks and note pages into the PDF itself, with Nib's editable copy inside, so the notes travel with the file and stay editable when reopened in Nib.
- **Crash recovery**: unsaved changes are copied to this device every few seconds and offered back after a crash or an accidental close.
- **Pen feel**: Precise, Balanced (default), Smooth. In the pen options and in Settings.
- **Phones**: tool bar across the bottom, all tools as a sheet, study mode as PDF/Notes tabs, 100 % interface size, 44 px touch targets, touch and hold to select a mark, two fingers scroll while the pen is on.
- **Network: none** for the web version too: the page's security rules (CSP) block every connection. Shown in Settings → Privacy.
- Settings → Version (Nib never checks for updates by itself; the desktop app has a "Get the latest version" button that opens the website in your browser).
- MIT licence.

**Changed**
- The pen smooths much less by default (it used to over-correct handwriting). Old strokes keep their look.
- The "Add my notes?" question when saving is gone: study notes are kept automatically, and Export → PDF with my notes adds them to a copy.
- The top bar adapts to the window width in every browser engine (it overflowed in Safari and the desktop app).
- Tablets start with the side panels closed.

**Fixed**
- Top bar buttons cut off on narrow windows with a big interface size in WebKit.


## 0.3.0-beta

**New**
- Tabs: several PDFs open at once (up to 8). Unsaved changes are kept per tab; closing asks to save. The browser also asks before closing with unsaved work.
- Rename a file by double-clicking its name in the top bar; Save uses that name.
- "Fill in this form?" card: detected boxes are shown only after you say yes (or later in Fill & Sign).
- Custom stamps: a drag-and-drop stamp designer (text, date, box, circle, line, logo) and PNG stamps, kept in the browser.
- Help tour (opens on first start, then under **?**): introduction, privacy, files, forms, drawing, study mode, redaction, tips.
- Settings: interface size 100–200 % (default 150 %), spelling on/off and language, forget saved data.
- Spelling check while typing; right-click shows suggestions.
- Notebook pages switch between lined, grid and blank.
- Tools button in the top bar shows or hides the tools panel.
- Landing page and app for GitHub Pages (`docs/`).

**Changed**
- Nib starts empty (the example worksheet is gone). Save, Study and Full page wait until a file is open.
- Interface is 50 % bigger by default.
- Study notes are no longer added to the saved PDF automatically: tick *Add my notes* when saving.
- Dropping several PDFs opens each in its own tab (hold Shift to add the pages to the open file instead).
- `Esc` while typing keeps the text (Undo removes it).

**Fixed**
- Full page showed a blank screen when only one file was open.
- Full page now works with study mode: PDF and notebook side by side, a *Notes* button to show or hide the notebook without leaving full page.
- Form detection now also runs on PDFs that already have some real form fields (fields already there are skipped). This was why later pages of some forms got no boxes.
- Empty decorative frames and a grey subtitle above a heading rule are no longer taken for fill-in places.
- Redacting several times no longer adds "(redacted)" to the name each time.
- Opening a new file no longer closes the current one.

## 0.2.0

Form-box detection, text tool, select tool, smoother pen, redaction, tools panel, comments, stamps, compress, protect, export images, study mode, full page.

## 0.1.0

First version: viewer with safe mode, page tools, pen, highlighter, signature, real form filling.
