// Save, Save as, Export, Print.
//
// Save writes over the file that was opened (desktop app, Chrome, Edge). The
// new version is built and checked first, the old one is kept as a backup
// (one per file, can be turned off), and only then the file is replaced.
// Where Nib cannot write back (Firefox, Safari, files from a plain upload),
// Save behaves like Save as.
import { baseName, exportPdf, plainText, saveNotes } from './doc';
import { backupJson, bookData, dropRecovery, flush, writeBook } from './library';
import { embedBookData } from './pdf/nibdata';
import { pagesToImages } from './pdf/images';
import { openRaw, pdfium } from './pdf/pdfium';
import { invoke, isDesktop } from './platform/env';
import { canWriteBack, hasSaveWindow, noteDownloaded, readRef, refLabel, sameRef, saveAs, saveFile, writeRef, type FileRef, type SaveResult } from './platform/files';
import { idbAll, idbDelete, idbPut } from './platform/idb';
import { store, type DocState } from './store';
import { ask } from './ui/dialog';
import { toast } from './ui/toast';

export type SaveOutcome = 'saved' | 'cancelled' | 'kept';

/** What Save writes for this tab. */
async function buildFor(state: DocState): Promise<Uint8Array> {
  if (state.bookId && state.keep === 'file') {
    const pdf = await exportPdf({ state, includeNotes: true, fillable: false });
    return embedBookData(pdf, bookData(state));
  }
  return exportPdf({ state, includeNotes: false });
}

/** Opens the new file once before it replaces anything. */
function verify(bytes: Uint8Array, pages: number): void {
  let raw;
  try {
    raw = openRaw(bytes);
  } catch {
    throw new Error('Nib could not check the new version, so the file was not changed.');
  }
  try {
    const n = pdfium().FPDF_GetPageCount(raw.doc);
    if (n !== pages) throw new Error(`The new version has ${n} pages instead of ${pages}, so the file was not changed.`);
  } finally {
    raw.close();
  }
}

function signed(state: DocState): boolean {
  return state.reports.some((r) => r.report.findings.some((f) => f.id === 'signatures'));
}

const signedOk = new WeakSet<DocState>();

// ---------- backups ----------

interface Backup {
  ref: FileRef;
  name: string;
  data: Blob;
  at: number;
}

const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
const BACKUP_MAX_FILES = 12;

async function findBackup(ref: FileRef): Promise<{ key: string; value: Backup } | null> {
  try {
    for (const b of await idbAll<Backup>('backups')) if (await sameRef(b.value.ref, ref)) return b;
  } catch {
    /* storage unavailable */
  }
  return null;
}

async function keepBackup(ref: FileRef, name: string): Promise<void> {
  const old = await readRef(ref);
  if (!old || old.length > BACKUP_MAX_BYTES) return;
  const prev = await findBackup(ref);
  const key = prev?.key ?? `bk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await idbPut('backups', key, { ref, name, data: new Blob([old as BlobPart]), at: Date.now() } satisfies Backup);
  const all = (await idbAll<Backup>('backups')).sort((a, b) => b.value.at - a.value.at);
  for (const b of all.slice(BACKUP_MAX_FILES)) await idbDelete('backups', b.key);
}

export async function hasBackup(state: DocState | null): Promise<boolean> {
  return !!state?.file && !!(await findBackup(state.file));
}

/** Writes the version from before the last Save back to the file, and reopens it. */
export async function restoreBackup(state: DocState, reopen: (name: string, bytes: Uint8Array, ref: FileRef) => Promise<void>): Promise<boolean> {
  if (!state.file) return false;
  const b = await findBackup(state.file);
  if (!b) {
    toast('There is no earlier version of this file.');
    return false;
  }
  const when = new Date(b.value.at).toLocaleString();
  const res = await ask({
    title: 'Restore the earlier version?',
    body: `<p>“${esc(b.value.name)}” goes back to how it was before you saved on ${esc(when)}. Changes made since then are lost.</p>`,
    actions: [
      { label: 'Cancel', value: false, kind: 'quiet' },
      { label: 'Restore', value: true, kind: 'danger' },
    ],
  });
  if (!res?.value) return false;
  const bytes = new Uint8Array(await b.value.data.arrayBuffer());
  await writeRef(state.file, bytes);
  await idbDelete('backups', b.key);
  await reopen(b.value.name, bytes, state.file);
  return true;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------- save ----------

/** Ctrl+S. */
export async function saveDoc(state: DocState): Promise<SaveOutcome> {
  if (state.bookId && state.keep === 'device') {
    await flush(state);
    toast('Your notes are saved on this device. The book file stays as it was.', 'ok', 4500);
    return 'kept';
  }
  const ref = state.file;
  if (!ref || !canWriteBack(ref)) return saveDocAs(state);

  if (signed(state) && !signedOk.has(state)) {
    const res = await ask({
      title: 'This file is digitally signed',
      body: '<p>Saving changes over it breaks the signature: other apps will show it as invalid. Save a copy instead to keep the signed original.</p>',
      actions: [
        { label: 'Cancel', value: 'cancel', kind: 'quiet' },
        { label: 'Save over it anyway', value: 'over' },
        { label: 'Save a copy', value: 'copy', kind: 'primary' },
      ],
    });
    if (!res || res.value === 'cancel') return 'cancelled';
    if (res.value === 'copy') return saveDocAs(state);
    signedOk.add(state);
  }

  const bytes = await buildFor(state);
  verify(bytes, state.plan.pages.length + (state.bookId && state.keep === 'file' ? state.plan.notes.length : 0));
  if (store.prefs.keepBackup) await keepBackup(ref, state.name).catch((e) => console.warn('backup failed', e));
  await writeRef(ref, bytes);
  store.markSaved(state);
  await afterSave(state);
  toast(state.bookId && state.keep === 'file' ? `Saved, with your notes inside “${shortLabel(ref)}”.` : `Saved over “${shortLabel(ref)}”.`, 'ok');
  return 'saved';
}

function shortLabel(ref: FileRef): string {
  const l = refLabel(ref);
  return l.split(/[\\/]/).pop() || l;
}

async function afterSave(state: DocState): Promise<void> {
  await dropRecovery(state);
  if (state.bookId) await writeBook(state).catch(() => undefined);
  store.emit('file');
}

/** Ctrl+Shift+S: choose where to save (also used when Save cannot write back). */
export async function saveDocAs(state: DocState): Promise<SaveOutcome> {
  const hasWindow = hasSaveWindow();
  // With a Save window the person chooses the name; for downloads keep the original safe.
  const suggested = hasWindow ? (state.saveName ?? state.name) : (state.saveName ?? `${baseName(state)} (edited).pdf`);
  const bytes = await buildFor(state);
  const r = await saveAs(suggested, bytes);
  if (r.status !== 'saved') return 'cancelled';
  if (r.ref) {
    state.file = r.ref;
    if (r.name !== state.name) {
      state.name = r.name;
      state.saveName = r.name;
      store.emit('tabs');
    }
  }
  store.markSaved(state);
  await afterSave(state);
  if (r.downloaded) noteDownloaded();
  else toast(`Saved as “${r.name}”. Save now writes to this file.`, 'ok', 4500);
  return 'saved';
}

// ---------- export ----------

export async function exportWithNotes(state: DocState): Promise<SaveResult> {
  const bytes = await exportPdf({ state, includeNotes: true });
  return saveFile(`${baseName(state)} (with notes).pdf`, bytes);
}

export async function exportFlattened(state: DocState): Promise<SaveResult> {
  const bytes = await exportPdf({ state, includeNotes: false, flatten: true, fillable: false });
  return saveFile(`${baseName(state)} (flattened).pdf`, bytes);
}

export async function exportNotesOnly(): Promise<SaveResult> {
  return saveNotes();
}

export async function exportText(state: DocState): Promise<SaveResult> {
  const text = plainText(state);
  if (!text.replace(/--- Page \d+ ---/g, '').trim()) throw new Error('This file has no text to export (it may be scanned pages).');
  return saveFile(`${baseName(state)}.txt`, new TextEncoder().encode(text), 'text/plain');
}

export async function exportBackup(state: DocState): Promise<SaveResult> {
  if (!state.bookId) throw new Error('Notes are kept for files used in study mode.');
  await flush(state);
  const b = await backupJson(state.bookId);
  if (!b) throw new Error('No notes found for this book.');
  return saveFile(b.name, b.bytes, 'application/json');
}

// ---------- print ----------

export interface PrintOptions {
  which: 'all' | 'current' | 'range';
  range: string;
  marks: boolean;
  notes: boolean;
}

/** "1-3, 5, 8-" → zero-based page indices (in document order). */
export function parseRange(text: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(count, Math.max(a, b)); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count) out.add(n - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

let printUrls: string[] = [];

function clearPrint(): void {
  for (const u of printUrls) URL.revokeObjectURL(u);
  printUrls = [];
  document.getElementById('print-root')?.remove();
}

export async function printDoc(state: DocState, o: PrintOptions, onProgress?: (k: number, n: number) => void): Promise<void> {
  const pages = state.plan.pages;
  const idx = o.which === 'current' ? [Math.min(state.current, pages.length - 1)] : o.which === 'range' ? parseRange(o.range, pages.length) : pages.map((_, i) => i);
  if (!idx.length) throw new Error('Enter pages to print, for example 1-3, 5.');
  const keys = idx.map((i) => pages[i].key);
  const pdf = await exportPdf({ state, keys, includeNotes: o.notes, plain: !o.marks, fillable: false });
  const total = keys.length + (o.notes ? state.plan.notes.length : 0);
  const files = await pagesToImages(pdf, Array.from({ length: total }, (_, i) => i), 150, 'image/jpeg', 'print', onProgress);
  clearPrint();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.setAttribute('aria-hidden', 'true');
  for (const f of files) {
    const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: 'image/jpeg' }));
    printUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    root.append(img);
  }
  document.body.append(root);
  await Promise.all([...root.querySelectorAll('img')].map((i) => i.decode().catch(() => undefined)));
  window.addEventListener('afterprint', clearPrint, { once: true });
  if (isDesktop()) await invoke('print_page');
  else window.print();
}
