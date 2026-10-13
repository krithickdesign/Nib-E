// True redaction. Content under each box is removed from the file, not just
// covered:
//   - text: the characters are deleted from the page content
//   - photos: the pixels under the box are replaced (PDFium blanks them)
//   - optional: whole pages are turned into images (removes vector drawings too)
//   - optional: hidden information is stripped (metadata, attachments,
//     scripts, bookmarks) by copying the pages into a fresh document
// Afterwards the result is re-opened and checked: no text may remain under
// any box.
import { PdfAnnotationSubtype } from '@embedpdf/models';
import type { Rect } from '../model';
import { newRawDoc, openRaw, pdfium, saveRaw, withBytes, withInts } from './core';
import { engine } from './pdfium';
import { encode, renderPage } from './raster';
import { charsIn, readPageChars } from './text';

export interface RedactMark {
  page: number;
  rects: Rect[];
}

export interface RedactOptions {
  /** Copy pages into a fresh file without metadata, attachments, scripts or bookmarks. */
  sanitize: boolean;
  /** Turn redacted pages into images (strongest; their text is no longer selectable). */
  rasterize: boolean;
}

export interface RedactResult {
  bytes: Uint8Array;
  /** Characters that were under the boxes before. */
  removedChars: number;
  /** Characters still found under the boxes afterwards (must be 0). */
  leftovers: number;
  pages: number;
}

const FLAT_PRINT = 1;
const RASTER_SCALE = 200 / 72;

function countUnder(bytes: Uint8Array, marks: RedactMark[]): number {
  const raw = openRaw(bytes);
  try {
    let n = 0;
    for (const mk of marks) {
      const chars = readPageChars(raw.doc, mk.page);
      const hit = new Set<number>();
      // A character is under a box when its centre is inside it (what the reader sees).
      for (const r of mk.rects) for (const c of charsIn(chars, r)) if (!/\s/.test(c.ch)) hit.add(c.i);
      n += hit.size;
    }
    return n;
  } finally {
    raw.close();
  }
}

/** Every annotation and form field becomes fixed page content (Export → Flattened PDF). */
export function flattenPdf(bytes: Uint8Array): Uint8Array {
  return flatten(bytes, 'all');
}

/** Flattens annotations and form fields into page content, so they can be redacted too. */
function flatten(bytes: Uint8Array, pages: number[] | 'all'): Uint8Array {
  const m = pdfium();
  const raw = openRaw(bytes);
  try {
    const n = m.FPDF_GetPageCount(raw.doc);
    const list = pages === 'all' ? Array.from({ length: n }, (_, i) => i) : pages;
    for (const i of list) {
      const page = m.FPDF_LoadPage(raw.doc, i);
      if (!page) continue;
      m.FPDFPage_Flatten(page, FLAT_PRINT);
      m.FPDF_ClosePage(page);
    }
    return saveRaw(raw.doc);
  } finally {
    raw.close();
  }
}

async function redactWithEngine(bytes: Uint8Array, marks: RedactMark[]): Promise<Uint8Array> {
  const e = engine();
  const doc = await e
    .openDocumentBuffer({ id: `redact-${Date.now()}`, content: bytes.slice().buffer as ArrayBuffer }, { normalizeRotation: true })
    .toPromise();
  try {
    for (const mk of marks) {
      const page = doc.pages[mk.page];
      for (const r of mk.rects) {
        const rect = { origin: { x: r.x, y: r.y }, size: { width: r.w, height: r.h } };
        await e
          .createPageAnnotation(doc, page, {
            type: PdfAnnotationSubtype.REDACT,
            id: '',
            pageIndex: mk.page,
            rect,
            segmentRects: [rect],
            color: '#000000',
            overlayColor: '#000000',
            strokeColor: '#000000',
            opacity: 1,
          } as never)
          .toPromise();
      }
      const ok = await e.applyAllRedactions(doc, page).toPromise();
      if (!ok) throw new Error(`Redaction failed on page ${mk.page + 1}.`);
    }
    return new Uint8Array((await e.saveAsCopy(doc).toPromise()) as ArrayBuffer);
  } finally {
    await e.closeDocument(doc).toPromise();
  }
}

/** Replaces the given pages with a picture of themselves. */
async function rasterize(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const m = pdfium();
  const raw = openRaw(bytes);
  try {
    for (const i of pages) {
      const old = m.FPDF_LoadPage(raw.doc, i);
      const rotation = old ? m.FPDFPage_GetRotation(old) : 0;
      if (old) m.FPDF_ClosePage(old);
      const img = renderPage(raw.doc, i, RASTER_SCALE);
      const jpeg = await encode(img, 'image/jpeg', 0.9);
      const w = img.w / RASTER_SCALE;
      const h = img.h / RASTER_SCALE;
      m.FPDFPage_Delete(raw.doc, i);
      const page = m.FPDFPage_New(raw.doc, i, w, h);
      try {
        const obj = m.FPDFPageObj_NewImageObj(raw.doc);
        const ok = withBytes(jpeg, (ptr, len) => m.EPDFImageObj_SetJpeg(page, 0, obj, ptr, len));
        if (!ok) throw new Error(`Could not turn page ${i + 1} into an image.`);
        m.FPDFImageObj_SetMatrix(obj, w, 0, 0, h, 0, 0);
        m.FPDFPage_InsertObject(page, obj);
        m.FPDFPage_SetRotation(page, rotation);
        m.FPDFPage_GenerateContent(page);
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
    return saveRaw(raw.doc);
  } finally {
    raw.close();
  }
}

/** Copies every page into a brand-new file: only what the pages use comes along. */
function sanitize(bytes: Uint8Array): Uint8Array {
  const m = pdfium();
  const src = openRaw(bytes);
  const dst = newRawDoc();
  try {
    const n = m.FPDF_GetPageCount(src.doc);
    const all = Array.from({ length: n }, (_, i) => i);
    const ok = withInts(all, (ptr) => m.FPDF_ImportPagesByIndex(dst.doc, src.doc, ptr, n, 0));
    if (!ok) throw new Error('Could not rebuild the cleaned file.');
    return saveRaw(dst.doc);
  } finally {
    dst.close();
    src.close();
  }
}

export async function applyRedactions(bytes: Uint8Array, marks: RedactMark[], opts: RedactOptions): Promise<RedactResult> {
  const list = marks.filter((mk) => mk.rects.length);
  if (!list.length) throw new Error('There are no redaction marks to apply.');
  const pages = [...new Set(list.map((mk) => mk.page))];
  const removedChars = countUnder(bytes, list);

  // Annotations and form fields under a box must become page content first,
  // otherwise their text would survive. Sanitizing flattens everything, because
  // form fields cannot survive the copy into a fresh file.
  let out = flatten(bytes, opts.sanitize ? 'all' : pages);
  out = await redactWithEngine(out, list);
  if (opts.rasterize) out = await rasterize(out, pages);
  if (opts.sanitize) out = sanitize(out);

  const leftovers = countUnder(out, list);
  if (leftovers) throw new Error(`Redaction check failed: ${leftovers} characters are still under the boxes. The file was not changed.`);
  return { bytes: out, removedChars, leftovers, pages: pages.length };
}

