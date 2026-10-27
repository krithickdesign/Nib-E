// Document operations: open, merge, detect form boxes, save, and the file
// tools (redact, compress, protect, export images, images to PDF).
import type { PdfDocumentObject } from '@embedpdf/models';
import { uid, type PageEntry, type Rect, type Rot, type Source } from './model';
import { checkDocument } from './pdf/check';
import { applyRedactions, type RedactResult } from './pdf/redact';
import { compressPdf, type CompressOptions, type CompressResult } from './pdf/compress';
import { detectFields } from './pdf/detect';
import { buildPdf } from './pdf/export';
import { imagesToPdf, pagesToImages, zip, type PageImage } from './pdf/images';
import { normaliseImage } from './pdf/raster';
import { findText, readPageChars, type PChar } from './pdf/text';
import { backgroundAround, findLine, type FoundLine } from './pdf/retype';
import { engine, free, heap, malloc, openRaw, pdfium, PDF_ERR_PASSWORD, PdfOpenError, type RawDoc } from './pdf/pdfium';
import { saveFile, type FileRef, type SaveResult } from './platform/files';
import { readBookData, type BookData } from './pdf/nibdata';
import { flattenPdf } from './pdf/redact';
import { uprightFieldText } from './pdf/formactions';
import { checkSignatures, type SignatureReport } from './pdf/signatures';
import { signPdf, type SignOptions } from './pdf/sign';
import { ocrPdf, type OcrOptions, type OcrResult } from './pdf/ocr';
import { MAX_TABS, store, tabState, type DocState } from './store';
import { images } from './ui/draw';

export type PasswordAsker = (fileName: string, wrongOnce: boolean) => Promise<string | null>;

let askPassword: PasswordAsker = async () => null;
export function setPasswordAsker(fn: PasswordAsker): void {
  askPassword = fn;
}

export class Cancelled extends Error {}

const passwords = new Map<string, string>();

async function openInEngine(name: string, bytes: Uint8Array): Promise<{ doc: PdfDocumentObject; password: string }> {
  let password = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const doc = await engine()
        .openDocumentBuffer({ id: uid('d'), content: bytes.slice().buffer as ArrayBuffer }, { password, normalizeRotation: true })
        .toPromise();
      return { doc, password };
    } catch (e) {
      const code = (e as { reason?: { code?: number } })?.reason?.code ?? 1;
      if (code !== PDF_ERR_PASSWORD) throw new PdfOpenError(code);
      const answer = await askPassword(name, attempt > 0);
      if (answer === null) throw new Cancelled('Cancelled');
      password = answer;
    }
  }
}

function entriesFor(src: Source): PageEntry[] {
  return src.doc.pages.map((pg) => ({
    key: uid('p'),
    src: src.id,
    index: pg.index,
    w: pg.size.width,
    h: pg.size.height,
    baseRot: (pg.rotation % 4) as Rot,
    rot: 0,
    template: 'blank',
    items: [],
  }));
}

async function load(name: string, original: Uint8Array) {
  // Sideways answers in form boxes on turned pages: see uprightFieldText.
  let bytes = original;
  try {
    bytes = await uprightFieldText(original);
  } catch (e) {
    console.warn('could not check the form boxes', e);
  }
  const { doc, password } = await openInEngine(name, bytes);
  const source: Source = { id: doc.id, name, doc, bytes };
  passwords.set(doc.id, password);
  const report = checkDocument(bytes, password);
  report.encrypted = !!doc.isEncrypted;
  return { source, report };
}

// ---------- raw copies for text and detection ----------

const raws = new Map<string, RawDoc>();
const charCache = new Map<string, PChar[]>();

function findSource(srcId: string): Source | undefined {
  for (const t of store.tabs) {
    const s = t.sources.get(srcId);
    if (s) return s;
  }
  return store.doc?.sources.get(srcId);
}

function rawFor(srcId: string): RawDoc | null {
  let r = raws.get(srcId);
  if (r) return r;
  const src = findSource(srcId);
  if (!src) return null;
  r = openRaw(src.bytes, passwords.get(srcId) ?? '');
  raws.set(srcId, r);
  return r;
}

/** Characters of a document page (cached). Pages added by Nib-E have none. */
export function pageChars(p: PageEntry): PChar[] {
  if (p.src === null) return [];
  const key = `${p.src}:${p.index}`;
  let c = charCache.get(key);
  if (!c) {
    const r = rawFor(p.src);
    c = r ? readPageChars(r.doc, p.index) : [];
    charCache.set(key, c);
  }
  return c;
}

// ---------- attached files (also PDF Portfolios) ----------

export interface Attachment {
  index: number;
  name: string;
  size: number;
}

/** Files attached to the open document (Nib-E never opens them by itself). */
export function listAttachments(state: DocState | null = store.doc): Attachment[] {
  if (!state) return [];
  const r = rawFor(state.primary);
  if (!r) return [];
  const m = pdfium();
  const n = Math.max(0, m.FPDFDoc_GetAttachmentCount(r.doc));
  const out: Attachment[] = [];
  for (let i = 0; i < Math.min(n, 500); i++) {
    const a = m.FPDFDoc_GetAttachment(r.doc, i);
    if (!a) continue;
    const len = m.FPDFAttachment_GetName(a, 0, 0);
    let name = `Attachment ${i + 1}`;
    if (len > 2) {
      const buf = malloc(len);
      try {
        m.FPDFAttachment_GetName(a, buf, len);
        name = new TextDecoder('utf-16le').decode(heap().slice(buf, buf + len - 2)) || name;
      } finally {
        free(buf);
      }
    }
    const sizePtr = malloc(8);
    let size = 0;
    try {
      if (m.FPDFAttachment_GetFile(a, 0, 0, sizePtr)) size = new Uint32Array(heap().buffer, sizePtr, 1)[0];
    } finally {
      free(sizePtr);
    }
    out.push({ index: i, name, size });
  }
  return out;
}

/** The bytes of one attached file. */
export function attachmentBytes(index: number, state: DocState | null = store.doc): Uint8Array {
  if (!state) throw new Error('Open a PDF first.');
  const r = rawFor(state.primary);
  if (!r) throw new Error('The file is no longer open.');
  const m = pdfium();
  const a = m.FPDFDoc_GetAttachment(r.doc, index);
  if (!a) throw new Error('This attachment could not be read.');
  const sizePtr = malloc(8);
  try {
    if (!m.FPDFAttachment_GetFile(a, 0, 0, sizePtr)) throw new Error('This attachment is empty or damaged.');
    const size = new Uint32Array(heap().buffer, sizePtr, 1)[0];
    const buf = malloc(Math.max(1, size));
    try {
      if (!m.FPDFAttachment_GetFile(a, buf, size, sizePtr)) throw new Error('This attachment could not be read.');
      return heap().slice(buf, buf + size);
    } finally {
      free(buf);
    }
  } finally {
    free(sizePtr);
  }
}

/** The line of the PDF's own text at (x, y) on a page, with its look (Edit text). */
export function lineAt(p: PageEntry, x: number, y: number): FoundLine | null {
  if (p.src === null) return null;
  const r = rawFor(p.src);
  return r ? findLine(r.doc, p.index, pageChars(p), x, y) : null;
}

/** Colour behind an area of a page (white if it can't be worked out). */
export function lineBackground(p: PageEntry, area: Rect): string {
  if (p.src === null) return '#ffffff';
  const r = rawFor(p.src);
  try {
    return r ? backgroundAround(r.doc, p.index, `${p.src}:${p.index}`, { ...area, pad: 1.2 }) : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

/** Frees the engine memory of a closed document. */
function release(state: DocState): void {
  for (const id of state.sources.keys()) {
    raws.get(id)?.close();
    raws.delete(id);
    for (const k of [...charCache.keys()]) if (k.startsWith(`${id}:`)) charCache.delete(k);
    try {
      engine().closeDocument(state.sources.get(id)!.doc);
    } catch {
      /* already closed */
    }
  }
}

/** Finds fill-in boxes on every page of a source, a few pages at a time. */
async function detectSource(state: DocState, srcId: string): Promise<void> {
  const src = state.sources.get(srcId);
  const r = rawFor(srcId);
  if (!src || !r) return;
  state.detecting = true;
  const n = src.doc.pageCount;
  const tell = () => {
    if (store.doc === state) store.emit('fields');
  };
  for (let i = 0; i < Math.min(n, 500); i++) {
    if (state.closed) return;
    try {
      // Places that already are real form fields are skipped inside detectFields.
      const f = detectFields(r.doc, i, `${srcId}:${i}:`);
      if (f.length) state.fields.set(`${srcId}:${i}`, f);
    } catch (e) {
      console.warn('detection failed on page', i + 1, e);
    }
    if (i % 4 === 3) {
      tell();
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  state.detecting = false;
  tell();
}

/** Detected boxes in a document (whether shown or not). */
export function fieldCount(state: DocState | null = store.doc): number {
  let n = 0;
  for (const list of state?.fields.values() ?? []) n += list.length;
  return n;
}

export class TooManyTabs extends Error {}

function newState(name: string, source: Source, report: DocState['reports'][number]['report'], isSample: boolean): DocState {
  return {
    name,
    primary: source.id,
    sources: new Map([[source.id, source]]),
    plan: { pages: entriesFor(source), notes: [], hf: null, wm: null },
    reports: [{ sourceId: source.id, name, report }],
    isSample,
    fields: new Map(),
    hasForm: report.findings.some((f) => f.id === 'form' || f.id === 'xfa'),
    ...tabState(),
  };
}

export interface OpenOptions {
  isSample?: boolean;
  /** Where the file is on disk, when Nib-E may save back to it. */
  ref?: FileRef | null;
}

export type OpenHook = (state: DocState, original: Uint8Array, book: BookData | null) => Promise<void>;
let openHook: OpenHook | null = null;
/** Runs after a file opened (the study library restores notes here). */
export function setOpenHook(fn: OpenHook): void {
  openHook = fn;
}

/** Opens a PDF in a new tab. The untouched sample is replaced instead of kept. */
export async function openBytes(name: string, bytes: Uint8Array, opts: OpenOptions | boolean = {}): Promise<DocState> {
  const o: OpenOptions = typeof opts === 'boolean' ? { isSample: opts } : opts;
  const isSample = !!o.isSample;
  const sample = store.tabs.find((t) => t.isSample && !t.dirty);
  if (store.tabs.length >= MAX_TABS && !sample) throw new TooManyTabs(`${MAX_TABS} files are open. Close one to open another.`);
  // A file saved with "write notes into the book": open the book as it was, then restore the notes.
  let book: BookData | null = null;
  let content = bytes;
  try {
    const found = readBookData(bytes);
    if (found) {
      book = found.data;
      content = found.clean;
    }
  } catch (e) {
    console.warn('could not read Nib-E notes in this file', e);
  }
  const { source, report } = await load(name, content);
  const state = newState(name, source, report, isSample);
  state.file = o.ref ?? null;
  if (sample && !isSample) {
    store.replaceTab(sample, state);
    state.id = `t${Math.random().toString(36).slice(2, 9)}`;
    store.activate(state);
    release(sample);
  } else store.addTab(state);
  // A newly opened file starts with the Select tool, so nothing gets drawn on it by accident.
  if (!store.study && !['select', 'hand'].includes(store.tool)) store.setTool('select');
  void detectSource(state, source.id);
  if (openHook) {
    try {
      await openHook(state, bytes, book);
    } catch (e) {
      console.warn('after-open step failed', e);
    }
  }
  return state;
}

/** Adds another file's pages as a source of an open document, without adding pages (used by recovery). */
export async function addSource(state: DocState, name: string, bytes: Uint8Array): Promise<string> {
  const { source, report } = await load(name, bytes);
  state.sources.set(source.id, source);
  state.reports.push({ sourceId: source.id, name, report });
  void detectSource(state, source.id);
  return source.id;
}

/** Closes a tab without asking (the caller asks about unsaved changes). */
export function closeDoc(state: DocState): void {
  store.removeTab(state);
  release(state);
}

export async function openFile(file: File, ref: FileRef | null = null): Promise<DocState> {
  return openBytes(file.name, new Uint8Array(await file.arrayBuffer()), { ref });
}


/** Adds every page of another PDF to the end of the open document. */
export async function mergeBytes(name: string, bytes: Uint8Array): Promise<number> {
  const state = store.doc;
  if (!state) {
    await openBytes(name, bytes);
    return store.pages.length;
  }
  const { source, report } = await load(name, bytes);
  state.sources.set(source.id, source);
  state.reports.push({ sourceId: source.id, name, report });
  const entries = entriesFor(source);
  store.appendPages(entries);
  if (state.isSample) state.isSample = false;
  void detectSource(state, source.id);
  return entries.length;
}

export async function mergeFile(file: File): Promise<number> {
  return mergeBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

// ---------- images ----------

export async function loadImage(file: Blob): Promise<{ id: string; w: number; h: number }> {
  const img = await normaliseImage(file);
  const id = uid('img');
  images.set(id, { bytes: img.bytes, mime: img.mime, w: img.w, h: img.h, bitmap: img.bitmap });
  return { id, w: img.w, h: img.h };
}

export async function imagesAsPdf(files: File[], size: 'a4' | 'fit'): Promise<Uint8Array> {
  const list: PageImage[] = [];
  for (const f of files) {
    const img = await normaliseImage(f);
    list.push({ bytes: img.bytes, mime: img.mime, w: img.w, h: img.h });
    img.bitmap.close();
  }
  return imagesToPdf(list, size);
}

// ---------- export ----------

export function baseName(state: DocState | null = store.doc): string {
  return (state?.name ?? 'document.pdf').replace(/\.pdf$/i, '').replace(/ \(sample\)$/, '');
}

export function outputName(suffix = 'edited'): string {
  return `${baseName()} (${suffix}).pdf`;
}

/** Makes a usable file name from what the person typed. */
export function cleanName(typed: string): string {
  const n = typed.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '').trim();
  return n ? `${n}.pdf` : '';
}

export function pendingRedactions(): number {
  return store.pages.reduce((n, p) => n + p.items.filter((it) => it.type === 'redact').length, 0);
}

export interface ExportOptions {
  keys?: string[];
  includeNotes?: boolean;
  fillable?: boolean;
  /** Leave out everything Nib-E added (the pages as they are, in the current order). */
  plain?: boolean;
  /** Turn annotations and form fields into fixed page content. */
  flatten?: boolean;
  state?: DocState;
}

export async function exportPdf(opts: ExportOptions = {}): Promise<Uint8Array> {
  const state = opts.state ?? store.doc;
  if (!state) throw new Error('Open a PDF first.');
  const plan = state.plan;
  const strip = (p: PageEntry): PageEntry => (opts.plain ? { ...p, items: [] } : p);
  const docPages = (opts.keys ? plan.pages.filter((p) => opts.keys!.includes(p.key)) : plan.pages).map(strip);
  const notes = opts.includeNotes ? plan.notes : [];
  const bytes = await buildPdf({
    primary: state.primary,
    sources: state.sources,
    pages: [...docPages, ...notes],
    docPages: docPages.length,
    hf: opts.plain ? null : plan.hf,
    wm: opts.plain ? null : plan.wm,
    fileName: baseName(state),
    fillable: opts.plain ? false : (opts.fillable ?? store.prefs.fillable),
    fieldsFor: (p) => store.fieldsFor(p),
  });
  return opts.flatten ? flattenPdf(bytes) : bytes;
}

/** Text of every page, for "Export → Text". */
export function plainText(state: DocState | null = store.doc): string {
  if (!state) return '';
  return state.plan.pages
    .map((p, i) => {
      const t = pageChars(p)
        .map((c) => c.ch)
        .join('')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      return `--- Page ${i + 1} ---\n${t}`;
    })
    .join('\n\n');
}

/** Note pages with something on them. */
export function writtenNotes(state: DocState | null = store.doc): number {
  return state?.plan.notes.filter((p) => p.items.length).length ?? 0;
}

export async function saveSelection(keys: string[]): Promise<SaveResult> {
  const bytes = await exportPdf({ keys, includeNotes: false });
  return saveFile(outputName(keys.length === 1 ? 'page' : `${keys.length} pages`), bytes);
}

export async function saveNotes(): Promise<SaveResult> {
  const state = store.doc;
  if (!state || !state.plan.notes.length) throw new Error('There are no notes yet.');
  const bytes = await buildPdf({
    primary: state.primary,
    sources: state.sources,
    pages: state.plan.notes,
    docPages: 0,
    hf: null,
    wm: null,
    fileName: baseName(),
    fillable: false,
    fieldsFor: () => [],
  });
  return saveFile(`${baseName()} (notes).pdf`, bytes);
}

// ---------- redaction ----------

export async function redactNow(): Promise<RedactResult> {
  const state = store.doc;
  if (!state) throw new Error('Open a PDF first.');
  const marks = state.plan.pages.map((p, i) => ({ page: i, rects: p.items.filter((it) => it.type === 'redact').map((r) => ({ x: (r as Rect).x, y: (r as Rect).y, w: (r as Rect).w, h: (r as Rect).h })) }));
  const bytes = await exportPdf({ includeNotes: false, fillable: false });
  const result = await applyRedactions(bytes, marks, { sanitize: store.prefs.sanitize, rasterize: store.prefs.rasterize });
  // The redacted file replaces the open one in the same tab. Notes stay.
  const base = baseName(state).replace(/( \(redacted\))+$/i, '');
  const name = `${base} (redacted).pdf`;
  const loaded = await load(name, result.bytes);
  const next = newState(name, loaded.source, loaded.report, false);
  next.plan = { ...next.plan, notes: state.plan.notes };
  next.saveName = name;
  next.dirty = true;
  next.fieldsOn = state.fieldsOn;
  // Stay on the page you were on (the redacted file has the same pages).
  next.current = Math.min(state.current, Math.max(0, next.plan.pages.length - 1));
  store.replaceTab(state, next);
  release(state);
  void detectSource(next, loaded.source.id);
  store.emit('dirty');
  return result;
}

export function markSearch(query: string): number {
  let count = 0;
  const pages = store.pages.map((p) => {
    const chars = pageChars(p);
    const q = query.trim().toLowerCase();
    if (!q || !chars.length) return p;
    const hits: Rect[][] = findText(chars, q);
    if (!hits.length) return p;
    count += hits.length;
    return { ...p, items: [...p.items, ...hits.flat().map((r) => ({ id: uid('r'), type: 'redact' as const, x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 }))] };
  });
  if (count) store.commit({ pages });
  return count;
}

export function markWholePage(key: string): void {
  const hit = store.findPage(key);
  if (!hit) return;
  store.addItems(key, [{ id: uid('r'), type: 'redact', x: 0, y: 0, w: hit.page.w, h: hit.page.h }]);
}

// ---------- compress, protect, export images ----------

export async function compressAndSave(opts: CompressOptions, onProgress?: (page: number, pages: number) => void): Promise<CompressResult & { saved: SaveResult }> {
  const bytes = await exportPdf();
  const res = await compressPdf(bytes, opts, onProgress);
  const saved = await saveFile(outputName('compressed'), res.bytes);
  return { ...res, saved };
}

export interface Permissions {
  print: boolean;
  copy: boolean;
  edit: boolean;
}

/** Permission bits (PDF spec table 22). Unused high bits must be 1. */
function permissionFlags(p: Permissions): number {
  let f = 0xfffff0c0 | 512; // reserved bits + accessibility extraction
  if (p.print) f |= 4 | 2048;
  if (p.copy) f |= 16;
  if (p.edit) f |= 8 | 32 | 256 | 1024;
  return f >>> 0;
}

export async function protectAndSave(password: string, perms: Permissions): Promise<SaveResult> {
  if (password.length < 4) throw new Error('Use a password with at least 4 characters.');
  const bytes = await exportPdf();
  const e = engine();
  const doc = await e.openDocumentBuffer({ id: uid('enc'), content: bytes.slice().buffer as ArrayBuffer }, { normalizeRotation: true }).toPromise();
  try {
    const restrict = !perms.print || !perms.copy || !perms.edit;
    // Without restrictions the owner password can equal the open password.
    const owner = restrict ? crypto.getRandomValues(new Uint32Array(4)).join('-') : password;
    const ok = await e.setDocumentEncryption(doc, password, owner, permissionFlags(perms)).toPromise();
    if (!ok) throw new Error('Could not protect this file.');
    const out = new Uint8Array((await e.saveAsCopy(doc).toPromise()) as ArrayBuffer);
    return saveFile(outputName('protected'), out);
  } finally {
    await e.closeDocument(doc).toPromise();
  }
}

export async function exportImages(opts: { dpi: number; mime: 'image/png' | 'image/jpeg'; keys?: string[] }, onProgress?: (k: number, n: number) => void): Promise<SaveResult> {
  const bytes = await exportPdf({ includeNotes: false, keys: opts.keys });
  const n = opts.keys?.length ?? store.pages.length;
  const files = await pagesToImages(bytes, Array.from({ length: n }, (_, i) => i), opts.dpi, opts.mime, baseName(), onProgress);
  if (files.length === 1) return saveFile(files[0].name, files[0].bytes, opts.mime);
  return saveFile(`${baseName()} (images).zip`, zip(files), 'application/zip');
}

// ---------- digital signatures ----------

const sigCache = new Map<string, Promise<SignatureReport[]>>();

/** Checks the signatures of the primary file, as it was opened (cached). */
export function documentSignatures(state: DocState | null = store.doc): Promise<SignatureReport[]> {
  if (!state) return Promise.resolve([]);
  const src = state.sources.get(state.primary);
  if (!src) return Promise.resolve([]);
  let p = sigCache.get(src.id);
  if (!p) {
    p = checkSignatures(src.bytes, passwords.get(src.id) ?? '');
    sigCache.set(src.id, p);
  }
  return p;
}

/** Signs the document as it is now with a certificate file and saves a signed copy. */
export async function signAndSave(opts: SignOptions): Promise<{ saved: SaveResult; name: string; bytes: Uint8Array }> {
  const bytes = await exportPdf({ includeNotes: false });
  const signed = await signPdf(bytes, opts);
  const name = outputName('signed');
  const saved = await saveFile(name, signed);
  return { saved, name, bytes: signed };
}

// ---------- text recognition ----------

/** Pages (0-based) that look scanned: little or no text. */
export function scannedPages(state: DocState | null = store.doc): number[] {
  if (!state) return [];
  return state.plan.pages.map((p, i) => [i, pageChars(p).filter((c) => !/\s/.test(c.ch)).length] as const).filter(([, n]) => n <= 20).map(([i]) => i);
}

/** Recognises text on the chosen pages; the result replaces the open document (unsaved). */
export async function ocrNow(opts: Omit<OcrOptions, 'pages'> & { pages?: number[] }): Promise<Omit<OcrResult, 'bytes'>> {
  const state = store.doc;
  if (!state) throw new Error('Open a PDF first.');
  const pages = opts.pages ?? state.plan.pages.map((_, i) => i);
  const bytes = await exportPdf({ includeNotes: false, fillable: false });
  const result = await ocrPdf(bytes, { ...opts, pages });
  if (!result.pagesRead) return result;
  const name = state.name;
  const loaded = await load(name, result.bytes);
  const next = newState(name, loaded.source, loaded.report, false);
  next.plan = { ...next.plan, notes: state.plan.notes };
  next.saveName = state.saveName;
  next.file = state.file;
  next.dirty = true;
  next.fieldsOn = state.fieldsOn;
  // Stay on the page you were on (the redacted file has the same pages).
  next.current = Math.min(state.current, Math.max(0, next.plan.pages.length - 1));
  store.replaceTab(state, next);
  release(state);
  void detectSource(next, loaded.source.id);
  store.emit('dirty');
  return result;
}
