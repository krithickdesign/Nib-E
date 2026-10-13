// Checks that the pictures inside a PDF can still be decoded, before Nib-E
// writes it anywhere. A damaged JPEG (wrong bytes in its tables or data) makes
// the page show garbage or nothing in other readers, so Save stops instead.
//
// Two checks per JPEG picture:
//  1. structure: markers and Huffman tables are valid (works in every browser)
//  2. decoding: the browser decodes it (createImageBitmap rejects broken files)
import { free, heap, malloc, openRaw, pdfium } from './core';

const FPDF_PAGEOBJ_IMAGE = 3;

/** Problems in a JPEG's structure (empty = looks fine). */
export function jpegProblems(b: Uint8Array): string[] {
  const out: string[] = [];
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return ['no JPEG start marker'];
  let i = 2;
  let sawScan = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      out.push(`bad marker at ${i}`);
      break;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) {
      out.push(`segment ${m.toString(16)} runs past the end`);
      break;
    }
    if (m === 0xc4) {
      // DHT: one or more tables of [class/id][16 counts][values]
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end) {
        const tc = b[p];
        if (tc >> 4 > 1 || (tc & 15) > 3) out.push(`bad Huffman table id ${tc.toString(16)}`);
        let total = 0;
        let codes = 0;
        for (let k = 0; k < 16; k++) {
          const n = b[p + 1 + k];
          total += n;
          codes = (codes + n) * 2;
          if (n > 1 << (k + 1)) out.push(`impossible Huffman count ${n} for length ${k + 1}`);
        }
        if (total > 256 || codes > 1 << 17) out.push('bogus Huffman table');
        p += 17 + total;
      }
      if (p !== end) out.push('Huffman table length mismatch');
    }
    if (m === 0xda) {
      sawScan = true;
      break;
    }
    i += 2 + len;
  }
  if (!sawScan && !out.length) out.push('no image data');
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
    // Some encoders pad after EOI; look for it near the end.
    const tail = b.subarray(Math.max(0, b.length - 64));
    let found = false;
    for (let k = 0; k + 1 < tail.length; k++) if (tail[k] === 0xff && tail[k + 1] === 0xd9) found = true;
    if (!found) out.push('no JPEG end marker');
  }
  return out;
}

/** Decodes with the browser. Resolves false when the browser cannot decode it. */
export async function decodes(bytes: Uint8Array, mime: string): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true;
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const ok = bmp.width > 0 && bmp.height > 0;
    bmp.close();
    return ok;
  } catch {
    return false;
  }
}

function filterName(obj: number, i: number): string {
  const m = pdfium();
  const n = m.FPDFImageObj_GetImageFilter(obj, i, 0, 0);
  if (n <= 0) return '';
  const p = malloc(n);
  try {
    m.FPDFImageObj_GetImageFilter(obj, i, p, n);
    let s = '';
    for (let k = 0; k < n - 1; k++) s += String.fromCharCode(heap()[p + k]);
    return s;
  } finally {
    free(p);
  }
}

function rawData(obj: number): Uint8Array | null {
  const m = pdfium();
  const n = m.FPDFImageObj_GetImageDataRaw(obj, 0, 0);
  if (n <= 0 || n > 80_000_000) return null;
  const p = malloc(n);
  try {
    m.FPDFImageObj_GetImageDataRaw(obj, p, n);
    return heap().slice(p, p + n);
  } finally {
    free(p);
  }
}

export interface ImageCheck {
  /** 1-based page numbers with a damaged picture. */
  badPages: number[];
  /** The damaged pictures' bytes. */
  bad: { page: number; data: Uint8Array }[];
  checked: number;
  /** More pictures than the limit: the rest were not checked. */
  skipped: number;
}

/**
 * Checks the JPEG pictures on the given pages (all pages by default).
 * `limit` caps the number of decodes so very large scanned books stay fast.
 */
export async function checkImages(pdf: Uint8Array, opts: { pages?: number[]; limit?: number } = {}): Promise<ImageCheck> {
  const m = pdfium();
  const limit = opts.limit ?? 80;
  const found: { page: number; data: Uint8Array }[] = [];
  let skipped = 0;
  const raw = openRaw(pdf);
  try {
    const n = m.FPDF_GetPageCount(raw.doc);
    const pages = opts.pages ?? Array.from({ length: n }, (_, i) => i);
    for (const pi of pages) {
      if (pi < 0 || pi >= n) continue;
      const page = m.FPDF_LoadPage(raw.doc, pi);
      if (!page) continue;
      try {
        const count = m.FPDFPage_CountObjects(page);
        for (let o = 0; o < count; o++) {
          const obj = m.FPDFPage_GetObject(page, o);
          if (!obj || m.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_IMAGE) continue;
          if (m.FPDFImageObj_GetImageFilterCount(obj) !== 1 || filterName(obj, 0) !== 'DCTDecode') continue;
          if (found.length >= limit) {
            skipped += 1;
            continue;
          }
          const data = rawData(obj);
          if (data) found.push({ page: pi + 1, data });
        }
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
  } finally {
    raw.close();
  }
  const bad: { page: number; data: Uint8Array }[] = [];
  for (const f of found) {
    if (jpegProblems(f.data).length || !(await decodes(f.data, 'image/jpeg'))) bad.push(f);
  }
  return { badPages: [...new Set(bad.map((b) => b.page))].sort((a, b) => a - b), bad, checked: found.length, skipped };
}

export class DamagedOutput extends Error {
  constructor(public pages: number[]) {
    super(
      `Nib-E stopped: a picture on page ${pages.join(', ')} came out damaged, so the file was not written. Your original is unchanged. Please try again; if it happens again, use Help → Send feedback and say which steps you took.`,
    );
  }
}

/** True when `hay` contains the first bytes of `needle` (a picture copied unchanged). */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  const n = needle.subarray(0, Math.min(needle.length, 512));
  if (!n.length) return false;
  for (let i = hay.indexOf(n[0]); i >= 0 && i <= hay.length - n.length; i = hay.indexOf(n[0], i + 1)) {
    let k = 1;
    while (k < n.length && hay[i + k] === n[k]) k++;
    if (k === n.length) return true;
  }
  return false;
}

/**
 * Throws DamagedOutput when a picture in the output cannot be decoded and was
 * not already damaged in one of the `sources` (a broken file someone opened
 * must stay saveable; only damage made by Nib-E stops the save).
 */
export async function assertImagesOk(pdf: Uint8Array, pages?: number[], sources: Uint8Array[] = []): Promise<void> {
  const r = await checkImages(pdf, { pages });
  const fresh = r.bad.filter((b) => !sources.some((src) => contains(src, b.data)));
  if (fresh.length) throw new DamagedOutput([...new Set(fresh.map((b) => b.page))].sort((a, b) => a - b));
}
