// Text recognition (OCR) for scanned pages, with Tesseract (tesseract.js).
//
// Pages are rendered here, read by Tesseract in a web worker, and the words
// found are written back as invisible text exactly over the picture: the page
// looks the same, but text can be searched, selected and copied.
// The recognition files (engine and language data, about 8 MB) are served by
// Nib-E itself from the ocr/ folder next to the app; nothing is sent anywhere.
import { free, heap, malloc, openRaw, pdfium, readFloats, saveRaw, withBytes } from './core';
import { readPageChars } from './text';
import { fontBytes } from '../fonts';

export interface OcrLang {
  id: string;
  label: string;
}

export const OCR_LANGS: OcrLang[] = [
  { id: 'eng', label: 'English' },
  { id: 'deu', label: 'German' },
];

export interface OcrOptions {
  langs: string[];
  /** 0-based page indexes to read; others are left alone. */
  pages: number[];
  /** Also read pages that already have text. */
  force?: boolean;
  onProgress?: (done: number, total: number, status: string) => void;
}

export interface OcrResult {
  bytes: Uint8Array;
  pagesRead: number;
  skippedText: number;
  words: number;
  /** Average confidence (0-100). */
  confidence: number;
}

/** Folder with the recognition files, or null when this copy of Nib-E has none. */
export function ocrBase(): string | null {
  if (typeof location === 'undefined' || location.protocol === 'file:' || location.protocol === 'about:') return null;
  return new URL('ocr/', location.href).href;
}

let available: Promise<boolean> | null = null;
export function ocrAvailable(): Promise<boolean> {
  if (!available) {
    const base = ocrBase();
    available = base
      ? fetch(`${base}worker.min.js`, { method: 'HEAD', cache: 'no-store' })
          .then((r) => r.ok)
          .catch(() => false)
      : Promise.resolve(false);
  }
  return available;
}

const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** Text characters already on a page (scans have none or a few). */
function textCount(doc: number, i: number): number {
  try {
    return readPageChars(doc, i).filter((c) => !/\s/.test(c.ch)).length;
  } catch {
    return 0;
  }
}

const SCALE = 300 / 72; // render at 300 dpi
const MAX_PIXELS = 5000 * 5000;

interface Word {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  baseline?: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

function wordsOf(data: unknown): { words: Word[]; lineOf: Map<Word, { bbox: Word['bbox']; baseline?: Word['baseline'] }> } {
  const words: Word[] = [];
  const lineOf = new Map<Word, { bbox: Word['bbox']; baseline?: Word['baseline'] }>();
  type Line = { bbox: Word['bbox']; baseline?: Word['baseline']; words: Word[] };
  const blocks = (data as { blocks?: { paragraphs: { lines: Line[] }[] }[] | null }).blocks ?? [];
  for (const b of blocks)
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) {
          if (!w.text.trim()) continue;
          words.push(w);
          lineOf.set(w, l);
        }
  return { words, lineOf };
}

/** Recognises text on scanned pages and returns the PDF with an invisible text layer. */
export async function ocrPdf(bytes: Uint8Array, opts: OcrOptions): Promise<OcrResult> {
  const base = ocrBase();
  if (!base || !(await ocrAvailable())) throw new Error('Text recognition is not available in this copy of Nib-E. Use the desktop app or the online version.');
  const simd = WebAssembly.validate(SIMD_TEST);
  const { createWorker } = await import('tesseract.js');
  const progress = opts.onProgress ?? (() => undefined);
  let status = 'Starting…';
  let current = 0;
  const total = opts.pages.length;
  progress(0, total, status);
  const worker = await createWorker(opts.langs.join('+'), 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}${simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`,
    langPath: base.replace(/\/$/, ''),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') progress(current + m.progress, total, 'Reading text…');
      else if (m.status !== status) {
        status = m.status;
        progress(current, total, /load/i.test(m.status) ? 'Loading text recognition…' : 'Preparing…');
      }
    },
  }).catch((e: unknown) => {
    throw new Error(`Text recognition could not start (${String((e as Error)?.message ?? e)}).${simd ? '' : ' This system may be too old for it.'}`);
  });

  const m = pdfium();
  const raw = openRaw(bytes);
  let font = 0;
  let pagesRead = 0;
  let skippedText = 0;
  let wordCount = 0;
  let confSum = 0;
  try {
    const fontData = await fontBytes('noto', false, false);
    font = withBytes(fontData, (ptr, len) => m.FPDFText_LoadFont(raw.doc, ptr, len, 2, true));
    if (!font) throw new Error('Could not load the font for the text layer.');
    for (const i of opts.pages) {
      if (!opts.force && textCount(raw.doc, i) > 20) {
        skippedText++;
        current++;
        continue;
      }
      // Render the page as it is seen (rotation applied).
      const page0 = m.FPDF_LoadPage(raw.doc, i);
      if (!page0) continue;
      const rot = m.FPDFPage_GetRotation(page0); // 0..3, clockwise quarter turns
      // Unrotated crop box size.
      const cw = rot % 2 ? m.FPDF_GetPageHeightF(page0) : m.FPDF_GetPageWidthF(page0);
      const ch = rot % 2 ? m.FPDF_GetPageWidthF(page0) : m.FPDF_GetPageHeightF(page0);
      m.FPDF_ClosePage(page0);
      let scale = SCALE;
      if (cw * ch * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (cw * ch));
      const r = renderVisual(raw.doc, i, scale);
      const canvas = new OffscreenCanvas(r.w, r.h);
      canvas.getContext('2d')!.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const res = await worker.recognize(blob, {}, { blocks: true, text: false });
      const { words, lineOf } = wordsOf(res.data);

      const page = m.FPDF_LoadPage(raw.doc, i);
      if (!page) continue;
      try {
        // Visible (rotated) page size in points; the render is r.w × r.h pixels of it.
        const vw = r.w / scale;
        const vh = r.h / scale;
        const box = cropBox(page);
        for (const w of words) {
          const line = lineOf.get(w);
          const x0 = w.bbox.x0 / scale;
          const x1 = w.bbox.x1 / scale;
          const bl = line?.baseline;
          let base = w.bbox.y1 / scale;
          if (bl && bl.x1 !== bl.x0) base = (bl.y0 + ((bl.y1 - bl.y0) * ((w.bbox.x0 + w.bbox.x1) / 2 - bl.x0)) / (bl.x1 - bl.x0)) / scale;
          const top = (line?.bbox.y0 ?? w.bbox.y0) / scale;
          const size = Math.max(2, Math.min(200, (base - top) / 0.78));
          const obj = m.FPDFPageObj_CreateTextObj(raw.doc, font, size);
          if (!obj) continue;
          const text = w.text.trim();
          const wptr = malloc((text.length + 1) * 2);
          try {
            m.pdfium.stringToUTF16(text, wptr, (text.length + 1) * 2);
            m.FPDFText_SetText(obj, wptr);
          } finally {
            free(wptr);
          }
          m.FPDFTextObj_SetTextRenderMode(obj, 3); // invisible
          const natural = objWidth(obj);
          const sx = natural > 0 ? (x1 - x0) / natural : 1;
          // Visible point (x0, base), top-left origin → unrotated top-left origin.
          const [ux, uy] = unrotate(x0, base, rot, vw, vh);
          const ang = (rot * Math.PI) / 2; // text runs counter-clockwise by the page rotation in user space
          const cos = Math.round(Math.cos(ang));
          const sin = Math.round(Math.sin(ang));
          m.FPDFPageObj_Transform(obj, sx * cos, sx * sin, -sin, cos, box.left + ux, box.top - uy);
          m.FPDFPage_InsertObject(page, obj);
          wordCount++;
          confSum += w.confidence;
        }
        m.FPDFPage_GenerateContent(page);
      } finally {
        m.FPDF_ClosePage(page);
      }
      pagesRead++;
      current++;
      progress(current, total, 'Reading text…');
    }
    const out = saveRaw(raw.doc);
    return { bytes: out, pagesRead, skippedText, words: wordCount, confidence: wordCount ? confSum / wordCount : 0 };
  } finally {
    if (font) m.FPDFFont_Close(font);
    raw.close();
    await worker.terminate().catch(() => undefined);
  }
}

/** Renders a page the way it is seen (its /Rotate applied), white background, no annotations. */
function renderVisual(doc: number, index: number, scale: number): { data: Uint8ClampedArray; w: number; h: number } {
  const m = pdfium();
  const page = m.FPDF_LoadPage(doc, index);
  if (!page) throw new Error(`Could not open page ${index + 1}.`);
  try {
    const w = Math.max(1, Math.round(m.FPDF_GetPageWidthF(page) * scale));
    const h = Math.max(1, Math.round(m.FPDF_GetPageHeightF(page) * scale));
    const bmp = m.FPDFBitmap_CreateEx(w, h, 4, 0, 0);
    if (!bmp) throw new Error('Not enough memory to read this page.');
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
      m.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0x10 | 0x800);
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      const stride = m.FPDFBitmap_GetStride(bmp);
      const data = new Uint8ClampedArray(w * h * 4);
      const px = heap();
      for (let y = 0; y < h; y++) data.set(px.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
      return { data, w, h };
    } finally {
      m.FPDFBitmap_Destroy(bmp);
    }
  } finally {
    m.FPDF_ClosePage(page);
  }
}

function cropBox(page: number): { left: number; top: number } {
  const m = pdfium();
  const p = malloc(16);
  try {
    if (m.FPDFPage_GetCropBox(page, p, p + 4, p + 8, p + 12) || m.FPDFPage_GetMediaBox(page, p, p + 4, p + 8, p + 12)) {
      const [l, , , t] = readFloats(p, 4);
      return { left: l, top: t };
    }
  } finally {
    free(p);
  }
  return { left: 0, top: m.FPDF_GetPageHeightF(page) };
}

function objWidth(obj: number): number {
  const m = pdfium();
  const p = malloc(16);
  try {
    m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12);
    const [l, , r] = readFloats(p, 4);
    return r - l;
  } finally {
    free(p);
  }
}

/**
 * A point on the page as seen (rotated by `rot` quarter turns clockwise, size vw × vh,
 * top-left origin) → the same point on the unrotated page (top-left origin).
 */
export function unrotate(u: number, v: number, rot: number, vw: number, vh: number): [number, number] {
  switch (rot & 3) {
    case 1: // seen = (H - y, x); H = vw
      return [v, vw - u];
    case 2:
      return [vw - u, vh - v];
    case 3: // seen = (y, W - x); W = vh
      return [vh - v, u];
    default:
      return [u, v];
  }
}
