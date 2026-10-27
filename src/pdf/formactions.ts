// Form helpers that go below the engine's public API:
// - finding Reset buttons (push buttons whose action is ResetForm),
// - pressing such a button, so PDFium resets the form itself (a standard
//   form action, no script runs; other button actions are never triggered),
// - default font settings for forms that lack them, written on save.
import { PDFArray, PDFButton, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PdfDocumentObject } from '@embedpdf/models';
import { free, malloc, openRaw, pdfium, readFloats } from './core';
import { engine } from './pdfium';

const resetCache = new Map<Uint8Array, Promise<Set<string>>>();

function isReset(dict: PDFDict | undefined): boolean {
  const a = dict?.lookup(PDFName.of('A'));
  return a instanceof PDFDict && a.lookup(PDFName.of('S')) === PDFName.of('ResetForm');
}

/** Full names of push buttons that reset the form (looked up once per file). */
export function resetButtons(bytes: Uint8Array): Promise<Set<string>> {
  let p = resetCache.get(bytes);
  if (!p) {
    p = (async () => {
      const out = new Set<string>();
      if (!hasAcroForm(bytes)) return out;
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        for (const f of doc.getForm().getFields()) {
          if (!(f instanceof PDFButton)) continue;
          if (isReset(f.acroField.dict) || f.acroField.getWidgets().some((w) => isReset(w.dict))) out.add(f.getName());
        }
      } catch {
        /* unreadable form: no reset buttons */
      }
      return out;
    })();
    resetCache.set(bytes, p);
  }
  return p;
}

interface EngineInternals {
  cache: { getContext(id: string): { acquirePage(i: number): PageCtx } | undefined };
  getAnnotationByName(pagePtr: number, name: string): number;
}
interface PageCtx {
  pagePtr: number;
  withFormHandle<T>(fn: (fh: number) => T): T;
  release(): void;
}

/**
 * Clicks a form button inside PDFium (mouse down and up in its middle). Used only
 * for buttons whose action is ResetForm (see resetButtons).
 */
export function pressButton(doc: PdfDocumentObject, pageIndex: number, annotationId: string): boolean {
  const eng = engine() as unknown as EngineInternals;
  const ctx = eng.cache?.getContext(doc.id);
  if (!ctx) return false;
  const m = pdfium();
  const pc = ctx.acquirePage(pageIndex);
  try {
    const annot = eng.getAnnotationByName(pc.pagePtr, annotationId);
    if (!annot) return false;
    const r = malloc(16);
    let x = 0;
    let y = 0;
    try {
      if (!m.FPDFAnnot_GetRect(annot, r)) return false;
      const [l, t, rr, b] = readFloats(r, 4);
      x = (l + rr) / 2;
      y = (t + b) / 2;
    } finally {
      free(r);
      m.FPDFPage_CloseAnnot(annot);
    }
    return pc.withFormHandle((fh) => {
      m.FORM_OnMouseMove(fh, pc.pagePtr, 0, x, y);
      const down = m.FORM_OnLButtonDown(fh, pc.pagePtr, 0, x, y);
      const up = m.FORM_OnLButtonUp(fh, pc.pagePtr, 0, x, y);
      return !!(down && up);
    });
  } finally {
    pc.release();
  }
}

function hasAcroForm(bytes: Uint8Array): boolean {
  const needle = [47, 65, 99, 114, 111, 70, 111, 114, 109]; // "/AcroForm"
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Forms without a default font (/DA) and font resources (/DR) are drawn
 * differently by every app (some show nothing, some a stray dash). Adds
 * Helvetica as the default, so other apps can draw the answers. Files that
 * already have both are returned unchanged.
 */
export async function ensureFormDefaults(bytes: Uint8Array): Promise<Uint8Array> {
  if (!hasAcroForm(bytes)) return bytes;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return bytes;
  }
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acro instanceof PDFDict)) return bytes;
  const fields = acro.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray) || fields.size() === 0) return bytes;
  const ctx = doc.context;
  let dr = acro.lookup(PDFName.of('DR'));
  let fonts = dr instanceof PDFDict ? dr.lookup(PDFName.of('Font')) : undefined;
  const hasDa = !!acro.lookup(PDFName.of('DA'));
  const hasHelv = fonts instanceof PDFDict && !!fonts.lookup(PDFName.of('Helv'));
  if (hasDa && fonts instanceof PDFDict && fonts.keys().length) return bytes;
  if (!(dr instanceof PDFDict)) {
    dr = ctx.obj({});
    acro.set(PDFName.of('DR'), dr);
  }
  if (!(fonts instanceof PDFDict)) {
    fonts = ctx.obj({});
    (dr as PDFDict).set(PDFName.of('Font'), fonts);
  }
  if (!hasHelv) {
    const helv = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
    (fonts as PDFDict).set(PDFName.of('Helv'), helv);
  }
  if (!hasDa) acro.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

const WIDGET = 20;

/** Most common text direction on an open page, in quarter turns as PDFium measures them (null: too little text to tell). */
function textQuarter(page: number): number | null {
  const m = pdfium();
  const tp = m.FPDFText_LoadPage(page);
  if (!tp) return null;
  try {
    const votes = [0, 0, 0, 0];
    const n = m.FPDFText_CountChars(tp);
    for (let i = 0; i < n; i++) {
      const u = m.FPDFText_GetUnicode(tp, i);
      if (u <= 32 || u === 0xfffe || u === 0xffff) continue;
      const a = m.FPDFText_GetCharAngle(tp, i);
      if (a < 0) continue;
      votes[((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4]++;
    }
    const total = votes.reduce((s, v) => s + v, 0);
    if (total < 6) return null;
    const best = votes.indexOf(Math.max(...votes));
    return votes[best] >= total * 0.6 ? best : null;
  } finally {
    m.FPDFText_ClosePage(tp);
  }
}

/** The value of a field key on a widget or one of its parents. */
function inherited(dict: PDFDict, key: string): unknown {
  let d: PDFDict | undefined = dict;
  for (let depth = 0; d && depth < 10; depth++) {
    const v = d.lookup(PDFName.of(key));
    if (v !== undefined) return v;
    const p: unknown = d.lookup(PDFName.of('Parent'));
    d = p instanceof PDFDict ? p : undefined;
  }
  return undefined;
}

/**
 * Form boxes on pages whose printed text runs sideways (landscape pages saved
 * turned, or a page that is shown turned) often lack the rotation for their
 * own text, so answers come out sideways next to upright labels. For each such
 * box that has no rotation of its own, this sets it to the direction of the
 * page's text, so answers read the same way as the labels around them.
 * Files with signatures, encrypted files and files without such boxes are
 * returned unchanged.
 */
export async function uprightFieldText(bytes: Uint8Array, password = ''): Promise<Uint8Array> {
  if (!hasAcroForm(bytes) || hasNeedle(bytes, '/ByteRange')) return bytes;
  const turned = new Map<number, number>();
  const m = pdfium();
  let raw;
  try {
    raw = openRaw(bytes, password);
  } catch {
    return bytes;
  }
  try {
    if (m.FPDF_GetSecurityHandlerRevision(raw.doc) !== -1) return bytes;
    const n = m.FPDF_GetPageCount(raw.doc);
    for (let i = 0; i < n; i++) {
      const page = m.FPDF_LoadPage(raw.doc, i);
      if (!page) continue;
      try {
        let widgets = 0;
        const count = m.FPDFPage_GetAnnotCount(page);
        for (let k = 0; k < count && !widgets; k++) {
          const a = m.FPDFPage_GetAnnot(page, k);
          if (!a) continue;
          if (m.FPDFAnnot_GetSubtype(a) === WIDGET) widgets++;
          m.FPDFPage_CloseAnnot(a);
        }
        if (!widgets) continue;
        const q = textQuarter(page);
        // PDFium measures the angle clockwise; /R counts counter-clockwise.
        if (q) turned.set(i, ((4 - q) % 4) * 90);
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
  } finally {
    raw.close();
  }
  if (!turned.size) return bytes;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return bytes;
  }
  const pages = doc.getPages();
  let changed = 0;
  for (const [i, deg] of turned) {
    const annots = pages[i]?.node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict) || a.lookup(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;
      const ft = inherited(a, 'FT');
      if (ft !== PDFName.of('Tx') && ft !== PDFName.of('Ch')) continue;
      let mk = a.lookup(PDFName.of('MK'));
      const r = mk instanceof PDFDict ? mk.lookup(PDFName.of('R')) : undefined;
      if (r instanceof PDFNumber && r.asNumber() % 360 !== 0) continue; // the form's own rotation wins
      if (!(mk instanceof PDFDict)) {
        mk = doc.context.obj({});
        a.set(PDFName.of('MK'), mk);
      }
      (mk as PDFDict).set(PDFName.of('R'), PDFNumber.of(deg));
      // Answers already in the file are drawn again the new way.
      if (inherited(a, 'V') !== undefined) a.delete(PDFName.of('AP'));
      changed++;
    }
  }
  if (!changed) return bytes;
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

function hasNeedle(bytes: Uint8Array, text: string): boolean {
  const needle = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}
