// Low-level PDFium helpers. This module has no bundler-specific imports, so
// the same code runs in the app and in Node-based tests.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export type Pdfium = WrappedPdfiumModule;

let mod: Pdfium | null = null;

export function setPdfium(m: Pdfium): void {
  mod = m;
}

export function pdfium(): Pdfium {
  if (!mod) throw new Error('PDF engine not started');
  return mod;
}

/** The wasm memory as bytes. Re-read it after any allocation: memory can grow. */
export function heap(): Uint8Array {
  return (pdfium().pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

export function malloc(size: number): number {
  const p = pdfium().pdfium.wasmExports.malloc(Math.max(4, size));
  if (!p) throw new Error('Out of memory');
  return p;
}

export function free(ptr: number): void {
  if (ptr) pdfium().pdfium.wasmExports.free(ptr);
}

export function withInts<T>(values: number[], fn: (ptr: number) => T): T {
  const ptr = malloc(values.length * 4);
  try {
    new Int32Array(heap().buffer, ptr, values.length).set(values);
    return fn(ptr);
  } finally {
    free(ptr);
  }
}

export function withFloats<T>(values: number[], fn: (ptr: number) => T): T {
  const ptr = malloc(values.length * 4);
  try {
    new Float32Array(heap().buffer, ptr, values.length).set(values);
    return fn(ptr);
  } finally {
    free(ptr);
  }
}

export function withBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
  const ptr = malloc(bytes.length);
  try {
    heap().set(bytes, ptr);
    return fn(ptr, bytes.length);
  } finally {
    free(ptr);
  }
}

export function withWide<T>(text: string, fn: (ptr: number) => T): T {
  const bytes = (text.length + 1) * 2;
  const ptr = malloc(bytes);
  try {
    pdfium().pdfium.stringToUTF16(text, ptr, bytes);
    return fn(ptr);
  } finally {
    free(ptr);
  }
}

export function readFloats(ptr: number, count: number): number[] {
  return Array.from(new Float32Array(heap().buffer, ptr, count));
}

export function readDoubles(ptr: number, count: number): number[] {
  return Array.from(new Float64Array(heap().buffer.slice(ptr, ptr + count * 8)));
}

export function readU32(ptr: number, count: number): number[] {
  return Array.from(new Uint32Array(heap().buffer, ptr, count));
}

/** A document opened directly through the C API (not through the engine). */
export interface RawDoc {
  doc: number;
  close(): void;
}

export const PDF_ERR_PASSWORD = 4;

export class PdfOpenError extends Error {
  constructor(public code: number) {
    super(code === PDF_ERR_PASSWORD ? 'This PDF needs a password.' : `PDFium could not open this file (error ${code}).`);
  }
}

export function openRaw(bytes: Uint8Array, password = ''): RawDoc {
  const m = pdfium();
  const filePtr = malloc(bytes.length);
  heap().set(bytes, filePtr);
  const doc = m.FPDF_LoadMemDocument(filePtr, bytes.length, password);
  if (!doc) {
    const code = m.FPDF_GetLastError();
    free(filePtr);
    throw new PdfOpenError(code);
  }
  let open = true;
  return {
    doc,
    close() {
      if (!open) return;
      open = false;
      m.FPDF_CloseDocument(doc);
      free(filePtr);
    },
  };
}

export function newRawDoc(): RawDoc {
  const m = pdfium();
  const doc = m.FPDF_CreateNewDocument();
  if (!doc) throw new Error('Could not create a document.');
  let open = true;
  return {
    doc,
    close() {
      if (open) m.FPDF_CloseDocument(doc);
      open = false;
    },
  };
}

/** Full rewrite of a document to bytes (not an incremental save). */
export function saveRaw(doc: number): Uint8Array {
  const m = pdfium();
  const writer = m.PDFiumExt_OpenFileWriter();
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new Error('PDFium could not write the file.');
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    const dataPtr = malloc(size);
    try {
      m.PDFiumExt_GetFileWriterData(writer, dataPtr, size);
      return heap().slice(dataPtr, dataPtr + size);
    } finally {
      free(dataPtr);
    }
  } finally {
    m.PDFiumExt_CloseFileWriter(writer);
  }
}

/**
 * Visible page area (crop box) in PDF user space. Nib's page points have
 * their origin at the top-left of this box and grow downwards:
 *   userX = left + x,   userY = top - y
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function pageBox(page: number, fallbackH: number): Box {
  const m = pdfium();
  const ptr = malloc(16);
  try {
    if (m.FPDF_GetPageBoundingBox(page, ptr)) {
      const [left, top, right, bottom] = readFloats(ptr, 4);
      return { left, top, right, bottom };
    }
  } finally {
    free(ptr);
  }
  return { left: 0, top: fallbackH, right: 0, bottom: 0 };
}

/** 2D affine matrix [a b c d e f] as in PDF: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m1: Mat, m2: Mat): Mat {
  // Apply m1 first, then m2.
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function objMatrix(obj: number): Mat {
  const ptr = malloc(24);
  try {
    if (pdfium().FPDFPageObj_GetMatrix(obj, ptr)) return readFloats(ptr, 6) as Mat;
  } finally {
    free(ptr);
  }
  return IDENTITY;
}

/** Bounds of a page object in page user space: [left, bottom, right, top]. */
export function objBounds(obj: number, parent: Mat | null): [number, number, number, number] {
  const ptr = malloc(16);
  try {
    pdfium().FPDFPageObj_GetBounds(obj, ptr, ptr + 4, ptr + 8, ptr + 12);
    const [l, b, r, t] = readFloats(ptr, 4);
    if (!parent) return [l, b, r, t];
    const pts = [apply(parent, l, b), apply(parent, r, b), apply(parent, r, t), apply(parent, l, t)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } finally {
    free(ptr);
  }
}

export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** PDF fonts that every reader has. Text written with them is not embedded. */
export type FontFamily = 'sans' | 'serif' | 'mono';

export function standardFontName(family: FontFamily, bold: boolean, italic: boolean): string {
  if (family === 'serif') return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  if (family === 'mono') return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier';
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica';
}

/** Characters the standard PDF fonts can encode (Windows-1252). */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || ch === '\n' || WIN_ANSI_EXTRA.includes(ch);
}

export function unsupportedChars(text: string): string[] {
  return [...new Set([...text].filter((c) => !isWinAnsi(c)))];
}
