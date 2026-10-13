// "Write notes into the book file" (study option B).
//
// The saved PDF is a normal PDF: marks show as annotations and page content,
// note pages are appended at the end, so any reader shows them. In addition it
// carries a small attachment, nib-notes.json, with Nib's editable copy of the
// marks and notes. Everything Nib wrote is tagged (page objects with the marked
// content tag /NibItem, annotations with a /NibItem key).
//
// When Nib opens such a file, it removes its own tagged content and the note
// pages again, so the marks are editable instead of baked in, and restores them
// from the attachment.
import type { HeaderFooter, Item, PageEntry, Template, Watermark } from '../model';
import type { StoredImage } from '../persist';
import { free, heap, malloc, openRaw, pdfium, saveRaw, withBytes, withWide } from './core';

export const NIB_TAG = 'NibItem';
export const NIB_FILE = 'nib-notes.json';

export interface BookData {
  app: 'nib';
  v: 1;
  bookId: string;
  /** Pages of the book itself (the note pages come after them). */
  bookPages: number;
  pages: { items: Item[]; template: Template }[];
  notes: PageEntry[];
  hf: HeaderFooter | null;
  wm: Watermark | null;
  images: Record<string, { mime: StoredImage['mime']; w: number; h: number; b64: string }>;
  current: number;
}

function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function imagesToB64(imgs: Record<string, StoredImage>): BookData['images'] {
  return Object.fromEntries(Object.entries(imgs).map(([k, v]) => [k, { mime: v.mime, w: v.w, h: v.h, b64: toB64(v.bytes) }]));
}

export function imagesFromB64(imgs: BookData['images']): Record<string, StoredImage> {
  return Object.fromEntries(Object.entries(imgs ?? {}).map(([k, v]) => [k, { mime: v.mime, w: v.w, h: v.h, bytes: fromB64(v.b64) }]));
}

function readUtf16(ptr: number, bytes: number): string {
  const h = heap();
  let s = '';
  for (let i = 0; i + 1 < bytes; i += 2) {
    const c = h[ptr + i] | (h[ptr + i + 1] << 8);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Adds Nib's data to a PDF as an attachment (replacing an older one). */
export function embedBookData(bytes: Uint8Array, data: BookData): Uint8Array {
  const m = pdfium();
  const raw = openRaw(bytes);
  try {
    removeAttachment(raw.doc);
    const att = withWide(NIB_FILE, (ptr) => m.FPDFDoc_AddAttachment(raw.doc, ptr));
    if (!att) throw new Error('Could not add the notes to the file.');
    const json = new TextEncoder().encode(JSON.stringify(data));
    const ok = withBytes(json, (ptr, len) => m.FPDFAttachment_SetFile(att, raw.doc, ptr, len));
    if (!ok) throw new Error('Could not add the notes to the file.');
    return saveRaw(raw.doc);
  } finally {
    raw.close();
  }
}

function attachmentName(att: number): string {
  const m = pdfium();
  const n = m.FPDFAttachment_GetName(att, 0, 0);
  if (n <= 2) return '';
  const ptr = malloc(n);
  try {
    m.FPDFAttachment_GetName(att, ptr, n);
    return readUtf16(ptr, n);
  } finally {
    free(ptr);
  }
}

function findAttachment(doc: number): number {
  const m = pdfium();
  const n = m.FPDFDoc_GetAttachmentCount(doc);
  for (let i = 0; i < n; i++) {
    const att = m.FPDFDoc_GetAttachment(doc, i);
    if (att && attachmentName(att) === NIB_FILE) return i;
  }
  return -1;
}

function removeAttachment(doc: number): void {
  const i = findAttachment(doc);
  if (i >= 0) pdfium().FPDFDoc_DeleteAttachment(doc, i);
}

function attachmentBytes(att: number): Uint8Array | null {
  const m = pdfium();
  const lenPtr = malloc(8);
  try {
    if (!m.FPDFAttachment_GetFile(att, 0, 0, lenPtr)) return null;
    const len = new Uint32Array(heap().buffer, lenPtr, 1)[0];
    if (!len || len > 200_000_000) return null;
    const buf = malloc(len);
    try {
      if (!m.FPDFAttachment_GetFile(att, buf, len, lenPtr)) return null;
      return heap().slice(buf, buf + len);
    } finally {
      free(buf);
    }
  } finally {
    free(lenPtr);
  }
}

function annotTagged(annot: number): boolean {
  const m = pdfium();
  const n = m.FPDFAnnot_GetStringValue(annot, NIB_TAG, 0, 0);
  return n > 2;
}

function objTagged(obj: number): boolean {
  const m = pdfium();
  const marks = m.FPDFPageObj_CountMarks(obj);
  if (marks <= 0) return false;
  const buf = malloc(64);
  const lenPtr = malloc(4);
  try {
    for (let i = 0; i < marks; i++) {
      const mark = m.FPDFPageObj_GetMark(obj, i);
      if (mark && m.FPDFPageObjMark_GetName(mark, buf, 64, lenPtr) && readUtf16(buf, 64) === NIB_TAG) return true;
    }
  } finally {
    free(buf);
    free(lenPtr);
  }
  return false;
}

/**
 * If the PDF carries Nib's notes, returns them together with the book as it
 * was before Nib wrote into it. Returns null for every other PDF (and for
 * password-protected files, which are opened as they are).
 */
export function readBookData(bytes: Uint8Array): { data: BookData; clean: Uint8Array } | null {
  // Cheap check first: no attachment name in the bytes, no work.
  if (!hasMarker(bytes)) return null;
  const m = pdfium();
  let raw;
  try {
    raw = openRaw(bytes);
  } catch {
    return null;
  }
  try {
    const i = findAttachment(raw.doc);
    if (i < 0) return null;
    const json = attachmentBytes(m.FPDFDoc_GetAttachment(raw.doc, i));
    if (!json) return null;
    let data: BookData;
    try {
      data = JSON.parse(new TextDecoder().decode(json));
    } catch {
      return null;
    }
    if (data?.app !== 'nib' || data.v !== 1 || !Array.isArray(data.pages)) return null;
    m.FPDFDoc_DeleteAttachment(raw.doc, i);
    // Drop the note pages at the end.
    const count = m.FPDF_GetPageCount(raw.doc);
    for (let p = count - 1; p >= data.bookPages; p--) m.FPDFPage_Delete(raw.doc, p);
    // Remove what Nib drew on the book pages.
    const n = Math.min(data.bookPages, m.FPDF_GetPageCount(raw.doc));
    for (let p = 0; p < n; p++) {
      const page = m.FPDF_LoadPage(raw.doc, p);
      if (!page) continue;
      try {
        for (let a = m.FPDFPage_GetAnnotCount(page) - 1; a >= 0; a--) {
          const annot = m.FPDFPage_GetAnnot(page, a);
          if (!annot) continue;
          const tagged = annotTagged(annot);
          m.FPDFPage_CloseAnnot(annot);
          if (tagged) m.FPDFPage_RemoveAnnot(page, a);
        }
        let changed = false;
        for (let o = m.FPDFPage_CountObjects(page) - 1; o >= 0; o--) {
          const obj = m.FPDFPage_GetObject(page, o);
          if (obj && objTagged(obj) && m.FPDFPage_RemoveObject(page, obj)) {
            m.FPDFPageObj_Destroy(obj);
            changed = true;
          }
        }
        if (changed) m.FPDFPage_GenerateContent(page);
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
    return { data, clean: saveRaw(raw.doc) };
  } finally {
    raw.close();
  }
}

const MARKER = new TextEncoder().encode('nib-notes');
const MARKER16 = [0x00, 0x6e, 0x00, 0x69, 0x00, 0x62, 0x00, 0x2d, 0x00, 0x6e]; // "nib-n" in UTF-16BE

function hasMarker(b: Uint8Array): boolean {
  // The attachment name is stored as a plain string (or UTF-16BE) in the file.
  for (let i = b.indexOf(0x6e); i >= 0 && i <= b.length - MARKER.length; i = b.indexOf(0x6e, i + 1)) {
    let k = 1;
    while (k < MARKER.length && b[i + k] === MARKER[k]) k++;
    if (k === MARKER.length) return true;
    if (i >= 1 && b[i - 1] === 0) {
      let j = 0;
      while (j < MARKER16.length && b[i - 1 + j] === MARKER16[j]) j++;
      if (j === MARKER16.length) return true;
    }
  }
  return false;
}
