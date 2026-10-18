# Testing Nib-E

Thanks for helping. Use Nib-E like your normal PDF reader for a while, then tell us what broke,
what confused you and what you missed.

**Privacy:** please don't attach private documents to reports. A screenshot (with personal details
covered) and a description are enough. If a specific public PDF misbehaves, link to it.

## Where to start

Install the desktop app from the Releases page (Windows, macOS, Linux), open the app from the
project site, or download `docs/app/index.html` and double-click it.
The Help tour (top right, **?**) explains the basics in a minute.

## Things to try

**New in 0.6.0**
- [ ] Content editor → Edit existing text: click a line, change it, save. Does it look the same as the rest of the page in another reader?
- [ ] Toolbox → Digital signatures: open a signed PDF (from a bank, an authority, a contract tool). Is the result plausible?
- [ ] Sign with your own .p12/.pfx certificate, then open the copy in another PDF reader: is the signature shown as valid?
- [ ] Toolbox → Text recognition on a scan: can you select and copy the text afterwards?
- [ ] Toolbox → Print check on a file for a print shop.
- [ ] Two-page view (click the zoom number at the bottom), Page Down / Page Up.
- [ ] Settings → Language: anything left in English that annoys you, or a translation that sounds wrong?
- [ ] Linux: does the AppImage or .deb start? If the window stays blank, start it once more.

**Desktop app**
- [ ] Install it. Was the first-start warning clear? (Windows: More info → Run anyway; macOS: Privacy & Security → Open Anyway)
- [ ] Double-click a PDF in your file manager / "Open with Nib-E". Drag a PDF onto the window.
- [ ] Save over a file, then Save ▾ → Restore earlier version.
- [ ] Close the window with unsaved changes: are you asked?

**Saving**
- [ ] Save writes over the opened file (Chrome, Edge, desktop app). Save as asks where.
- [ ] Firefox / Safari: Save downloads; is the tip about choosing a folder clear?
- [ ] Export: PDF with my notes, flattened PDF, text. Print a page range.
- [ ] Close the browser tab with unsaved work, reopen Nib-E: is the work offered back?

**Opening and tabs**
- [ ] Open several PDFs (button, drag and drop, Ctrl+O). Switch between tabs.
- [ ] Rename a file by double-clicking its name at the top, then Save.
- [ ] Close a tab with changes: are you asked to save? Close the browser tab with unsaved work.
- [ ] Open a password-protected PDF.

**Forms**
- [ ] A form *without* fields (e.g. a Word form exported to PDF): does the "Fill in this form?" card appear?
      Are the right places found? Any boxes found that shouldn't be (decoration, tables)? Any missed?
- [ ] A form *with* real fields: do they fill and save?
- [ ] Type with `Tab` / `Enter` between boxes. Does the text size and font match?
- [ ] *Toolbox → Form builder → Save as a fillable form*: does the result work in another reader?

**Writing and study**
- [ ] Pen and highlighter with mouse, finger and (if you have one) a stylus. Try each pen feel (Precise / Balanced / Smooth): which suits your handwriting?
- [ ] Study mode: write notes, switch pages between lined / grid / blank, add pages.
- [ ] Close the book, open it again: are notes back, at the right page? Try the "Continue studying" list.
- [ ] Toolbox → Study mode → *Write notes into the book*, Save, open the file in another reader.
- [ ] Text boxes: spelling suggestions on right-click.

**Stamps, comments, pages**
- [ ] Design your own stamp; add a PNG stamp; place and resize them.
- [ ] Sticky notes, highlights, shapes. Do they show in other PDF readers?
- [ ] Insert, rotate, reorder, delete, extract pages (Page manager). File merger.

**Redaction**
- [ ] Mark text and images, apply, save. Open the result in another reader and try to copy the text that was under a box.

**Comfort**
- [ ] *Toolbox → Settings → Interface size*: is 150 % right for you? Too big or too small?
- [ ] Dark mode, full page, small windows.
- [ ] A phone: bottom tool bar, Toolbox sheet, PDF/Notes tabs in study mode, two-finger scrolling while the pen is on, touch and hold on a mark to select it.

## How to report

In Nib-E: **Help → Send feedback** (it copies your text and opens the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSfy3FUAR3hxknKPvrZi9NFxmflDDaBQQIV0PNaT5af3yO8xDA/viewform); paste it into the last question). No account needed. Include:

1. What you did, step by step.
2. What you expected and what happened instead.
3. Browser and system (e.g. Chrome 130 on Windows 11).
4. A screenshot if it helps (cover personal details).

## Known limits in this version

See the *Known limits* list in [README.md](README.md).
