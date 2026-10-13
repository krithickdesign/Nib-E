# Changelog

## 0.5.0-beta

**New**
- **Nib-E**: new name, part of the Desk-E family (file names, app name, website). Saved data from 0.4 is kept.
- **Help menu** (top right): Help and tour, Keyboard shortcuts, What's new, Send feedback, Privacy and safe mode, About.
- **Send feedback**: choose Something broke / Confusing / Idea / General opinion, describe it, optionally add technical details (version, browser, system; never files). Opens the project's GitHub issue form filled in, or copies the text. Nib-E itself sends nothing.
- **Light / dark switch**: Settings → Appearance (Automatic, Light, Dark).
- **Logo opens the start page** in a new tab (web) or a new window (desktop app).

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
