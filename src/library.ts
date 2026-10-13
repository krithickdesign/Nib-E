// Study library and crash recovery. Everything is stored in this browser /
// this desktop app (IndexedDB) and never leaves the device.
//
// Study library ("keep notes separately", the default for study books):
//   the book file is never changed. Marks on its pages and the notebook are
//   saved here as you write, matched to the book by a fingerprint of the file.
//   Opening the same book again restores them and jumps to the last page.
//
// Study option B ("write notes into the book file"): Save writes the marks and
//   note pages into the PDF itself, plus Nib-E's editable copy (pdf/nibdata.ts).
//   The library keeps a mirror so nothing is lost before you save.
//
// Crash recovery: other files with unsaved changes are copied here every few
//   seconds, and offered back after a crash or an accidental close.
import { addSource, openBytes } from './doc';
import type { Plan } from './model';
import { hasWork, rebuild, restoreImages, snapshot, sourceOrder, type StoredPlan } from './persist';
import { imagesFromB64, imagesToB64, type BookData } from './pdf/nibdata';
import { canWriteBack, readPath, type FileRef, type FsHandle } from './platform/files';
import { askPersistence, idbAll, idbDelete, idbGet, idbPut } from './platform/idb';
import { store, type DocState } from './store';

export interface BookRecord {
  id: string;
  name: string;
  /** Fingerprint of the book file (for "notes kept separately"). */
  print: string | null;
  size: number;
  /** Where the book is, to reopen it from the library (a browser file handle or a path). */
  ref: FileRef | null;
  keep: 'device' | 'file';
  plan: StoredPlan;
  current: number;
  pages: number;
  notePages: number;
  created: number;
  updated: number;
}

// ---------- fingerprint ----------

/** Size + SHA-256 of the first and last 256 KB: fast even for very large books. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const part = 256 * 1024;
  const head = bytes.subarray(0, Math.min(part, bytes.length));
  const tail = bytes.subarray(Math.max(0, bytes.length - part));
  const buf = new Uint8Array(head.length + tail.length + 8);
  buf.set(head, 0);
  buf.set(tail, head.length);
  new DataView(buf.buffer).setFloat64(head.length + tail.length, bytes.length);
  let hash: Uint8Array;
  if (crypto?.subtle) hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  else {
    // No Web Crypto (very old browser or unusual context): FNV-1a in 4 lanes.
    const h = new Uint32Array([0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]);
    for (let i = 0; i < buf.length; i++) {
      const l = i & 3;
      h[l] = Math.imul(h[l] ^ buf[i], 16777619);
    }
    hash = new Uint8Array(h.buffer);
  }
  return `${bytes.length}:${[...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function newId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- book records ----------

export async function listBooks(): Promise<BookRecord[]> {
  try {
    return (await idbAll<BookRecord>('books')).map((r) => r.value).sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  try {
    return await idbGet<BookRecord>('books', id);
  } catch {
    return undefined;
  }
}

export async function forgetBook(id: string): Promise<void> {
  await idbDelete('books', id);
  for (const t of store.tabs) if (t.bookId === id) t.bookId = null;
  store.emit('library');
  store.emit('tabs');
}

function storableRef(ref: FileRef | null): FileRef | null {
  // Handles and paths can both be kept; handles need permission again after a restart.
  return ref;
}

/** Writes the current state of a study book to the library. */
export async function writeBook(state: DocState): Promise<boolean> {
  if (!state.bookId) return false;
  const prev = await getBook(state.bookId);
  const rec: BookRecord = {
    id: state.bookId,
    name: state.name,
    print: state.keep === 'device' ? state.print : (prev?.print ?? state.print),
    size: state.sources.get(state.primary)?.bytes.length ?? 0,
    ref: storableRef(state.file) ?? prev?.ref ?? null,
    keep: state.keep,
    plan: snapshot(state),
    current: state.current,
    pages: state.plan.pages.length,
    notePages: state.plan.notes.length,
    created: prev?.created ?? Date.now(),
    updated: Date.now(),
  };
  await idbPut('books', rec.id, rec);
  return true;
}

/** Turns the open file into a study book (when study mode is used with it). */
export async function makeBook(state: DocState): Promise<boolean> {
  if (state.bookId || state.isSample) return false;
  state.bookId = newId();
  state.keep = store.prefs.studyKeep;
  try {
    await writeBook(state);
    void askPersistence();
  } catch (e) {
    console.warn('library unavailable', e);
    state.bookId = null;
    return false;
  }
  if (state.keep === 'device') {
    // From now on edits are kept automatically: nothing "unsaved" any more.
    state.dirty = false;
    store.emit('dirty');
  }
  store.emit('library');
  store.emit('tabs');
  return true;
}

/** Switches where a book's notes are kept. */
export async function setKeep(state: DocState, keep: 'device' | 'file'): Promise<void> {
  if (!state.bookId) await makeBook(state);
  state.keep = keep;
  if (keep === 'file') state.dirty = true; // not in the file yet
  await writeBook(state).catch(() => undefined);
  store.emit('library');
  store.emit('dirty');
  store.emit('tabs');
}

/** Nib-E's editable copy of a book, written into the PDF with option B. */
export function bookData(state: DocState): BookData {
  const snap = snapshot(state);
  return {
    app: 'nib',
    v: 1,
    bookId: state.bookId ?? newId(),
    bookPages: state.plan.pages.length,
    pages: state.plan.pages.map((p) => ({ items: p.items, template: p.template })),
    notes: state.plan.notes,
    hf: state.plan.hf,
    wm: state.plan.wm,
    images: imagesToB64(snap.images),
    current: state.current,
  };
}

// ---------- after a file opened ----------

/** Restores notes for a book that was opened again. Called from doc.openBytes. */
export async function afterOpen(state: DocState, original: Uint8Array, book: BookData | null): Promise<void> {
  if (book) {
    // Option B file: notes come from the file itself.
    await restoreImages(imagesFromB64(book.images));
    const plan: Plan = {
      pages: state.plan.pages.map((p, i) => ({ ...p, items: book.pages[i]?.items ?? [], template: p.src === null ? (book.pages[i]?.template ?? p.template) : p.template })),
      notes: book.notes ?? [],
      hf: book.hf ?? null,
      wm: book.wm ?? null,
    };
    state.bookId = book.bookId;
    state.keep = 'file';
    store.restorePlan(state, plan, book.current ?? 0);
    state.dirty = false;
    await writeBook(state).catch(() => undefined);
    store.emit('library');
    store.emit('tabs');
    notify(state, 'file', plan);
    return;
  }

  state.print = await fingerprint(original);
  const books = await listBooks();
  const rec = books.find((b) => b.keep === 'device' && b.print === state.print);
  if (!rec) return;
  await restoreImages(rec.plan.images);
  const { plan, dropped } = rebuild(rec.plan, sourceOrder(state).slice(0, 1));
  if (!plan.pages.length) return;
  state.bookId = rec.id;
  state.keep = 'device';
  if (state.file) rec.ref = state.file;
  store.restorePlan(state, plan, rec.current);
  state.dirty = false;
  await writeBook(state).catch(() => undefined);
  store.emit('library');
  store.emit('tabs');
  notify(state, 'device', plan, dropped);
}

type Notice = (state: DocState, how: 'device' | 'file', plan: Plan, dropped: number) => void;
let notice: Notice = () => undefined;
export function setRestoreNotice(fn: Notice): void {
  notice = fn;
}
function notify(state: DocState, how: 'device' | 'file', plan: Plan, dropped = 0): void {
  notice(state, how, plan, dropped);
}

// ---------- reopening a book from the library ----------

/**
 * Opens a library book's file again. Returns false when Nib-E cannot reach the
 * file by itself (the caller then asks the person to open it).
 */
export async function reopenBook(rec: BookRecord): Promise<boolean> {
  const ref = rec.ref;
  if (!ref) return false;
  try {
    if (ref.kind === 'path') {
      const f = await readPath(ref.path);
      await openBytes(f.name, f.bytes, { ref: f.ref });
      return true;
    }
    const h = ref.handle as FsHandle;
    const perm = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (perm !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') return false;
    const file = await h.getFile();
    await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), { ref: canWriteBack(ref) ? ref : null });
    return true;
  } catch (e) {
    console.warn('could not reopen', e);
    return false;
  }
}

// ---------- backup file (.nib) ----------

export interface NibBackup {
  app: 'nib-notes';
  v: 1;
  book: Omit<BookRecord, 'ref' | 'plan'> & { plan: Omit<StoredPlan, 'images'> & { images: BookData['images'] } };
}

export async function backupJson(id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const rec = await getBook(id);
  if (!rec) return null;
  const { ref: _ref, plan, ...rest } = rec;
  const out: NibBackup = { app: 'nib-notes', v: 1, book: { ...rest, plan: { ...plan, images: imagesToB64(plan.images) } } };
  return { name: `${rec.name.replace(/\.pdf$/i, '')} (notes).nib`, bytes: new TextEncoder().encode(JSON.stringify(out)) };
}

/** Restores a .nib backup into the library. Returns the book name. */
export async function importBackup(bytes: Uint8Array): Promise<string> {
  let data: NibBackup;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('This is not a Nib-E notes file.');
  }
  if (data?.app !== 'nib-notes' || data.v !== 1 || !data.book?.plan) throw new Error('This is not a Nib-E notes file.');
  const b = data.book;
  const rec: BookRecord = { ...b, keep: 'device', ref: null, plan: { ...b.plan, images: imagesFromB64(b.plan.images) }, updated: Date.now() };
  await idbPut('books', rec.id, rec);
  store.emit('library');
  return rec.name;
}

// ---------- autosave ----------

const timers = new Map<string, number>();

function schedule(state: DocState, ms: number): void {
  clearTimeout(timers.get(state.id));
  timers.set(
    state.id,
    window.setTimeout(() => {
      timers.delete(state.id);
      void flush(state);
    }, ms),
  );
}

/** Saves a tab's work now (library for books, recovery copy for other files). */
export async function flush(state: DocState): Promise<void> {
  clearTimeout(timers.get(state.id));
  timers.delete(state.id);
  if (state.closed) return;
  try {
    if (state.bookId) {
      await writeBook(state);
      if (state.keep === 'device' && state.dirty) {
        state.dirty = false;
        store.emit('dirty');
        store.emit('tabs');
      }
      return;
    }
    if (state.dirty && !state.isSample) await writeRecovery(state);
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export async function flushAll(): Promise<void> {
  await Promise.all(store.tabs.map((t) => flush(t)));
}

// ---------- crash recovery ----------

interface RecoveryRecord {
  tab: string;
  name: string;
  saveName: string | null;
  sources: string[];
  plan: StoredPlan;
  current: number;
  ref: FileRef | null;
  updated: number;
  /** Last sign of life of the window that owns it (other open Nib-E windows are not offered). */
  alive: number;
}

const writtenSources = new Map<string, Set<string>>();

async function writeRecovery(state: DocState): Promise<void> {
  if (!hasWork(state.plan) && !state.plan.pages.some((p) => p.src === null)) {
    await dropRecovery(state);
    return;
  }
  const order = sourceOrder(state);
  const done = writtenSources.get(state.id) ?? new Set<string>();
  for (let i = 0; i < order.length; i++) {
    if (done.has(order[i])) continue;
    const src = state.sources.get(order[i]);
    if (!src) continue;
    await idbPut('recovery', `${state.id}:src:${i}`, { name: src.name, data: new Blob([src.bytes as BlobPart]) });
    done.add(order[i]);
  }
  writtenSources.set(state.id, done);
  const rec: RecoveryRecord = {
    tab: state.id,
    name: state.name,
    saveName: state.saveName,
    sources: order.map((id) => state.sources.get(id)?.name ?? ''),
    plan: snapshot(state),
    current: state.current,
    ref: state.file,
    updated: Date.now(),
    alive: Date.now(),
  };
  await idbPut('recovery', `${state.id}:plan`, rec);
}

export async function dropRecovery(state: DocState): Promise<void> {
  writtenSources.delete(state.id);
  try {
    const all = await idbAll<unknown>('recovery');
    for (const { key } of all) if (key.startsWith(`${state.id}:`)) await idbDelete('recovery', key);
  } catch {
    /* storage unavailable */
  }
}

let idleMs = 25_000;
/** How long a window must have been silent before its unsaved work is offered (tests use 0). */
export function setRecoveryIdle(ms: number): void {
  idleMs = ms;
}

/** Unsaved work left behind by a closed or crashed window. */
export async function pendingRecovery(): Promise<RecoveryRecord[]> {
  try {
    const all = await idbAll<RecoveryRecord>('recovery');
    const mine = new Set(store.tabs.map((t) => t.id));
    return all
      .filter(({ key, value }) => key.endsWith(':plan') && !mine.has(value.tab) && Date.now() - value.alive >= idleMs)
      .map(({ value }) => value)
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function discardRecovery(list: RecoveryRecord[]): Promise<void> {
  for (const r of list) {
    try {
      const all = await idbAll<unknown>('recovery');
      for (const { key } of all) if (key.startsWith(`${r.tab}:`)) await idbDelete('recovery', key);
    } catch {
      /* ignore */
    }
  }
}

/** Opens unsaved work again, each file in its own tab. */
export async function restoreRecovery(list: RecoveryRecord[]): Promise<number> {
  let n = 0;
  for (const r of list) {
    try {
      const srcs: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < r.sources.length; i++) {
        const s = await idbGet<{ name: string; data: Blob }>('recovery', `${r.tab}:src:${i}`);
        if (!s) break;
        srcs.push({ name: s.name, bytes: new Uint8Array(await s.data.arrayBuffer()) });
      }
      if (!srcs.length) continue;
      const state = await openBytes(srcs[0].name, srcs[0].bytes, { ref: r.ref && canWriteBack(r.ref) ? r.ref : null });
      const ids: (string | undefined)[] = [state.primary];
      for (const s of srcs.slice(1)) ids.push(await addSource(state, s.name, s.bytes));
      await restoreImages(r.plan.images);
      const { plan } = rebuild(r.plan, ids);
      if (state.bookId) {
        // The file is also a library book; its kept notes win, the recovery copy is dropped.
      } else {
        store.restorePlan(state, plan, r.current);
        state.name = r.name;
        state.saveName = r.saveName;
        state.dirty = true;
        store.emit('dirty');
        store.emit('tabs');
      }
      n += 1;
    } catch (e) {
      console.warn('could not restore', r.name, e);
    }
  }
  await discardRecovery(list);
  return n;
}

// ---------- wiring ----------

let heartbeat = 0;

export function startAutosave(): void {
  store.on((why) => {
    const doc = store.doc;
    if (!doc || doc.isSample) return;
    if (why === 'items' || why === 'pages' || why === 'notes' || why === 'decor' || why === 'history') {
      schedule(doc, doc.bookId ? 700 : 2500);
    } else if (why === 'current' && doc.bookId) {
      schedule(doc, 2000);
    } else if ((why === 'mode' || why === 'doc') && store.study && !doc.bookId) {
      void makeBook(doc);
    }
  });
  // Keep this window's recovery records marked as alive, so another Nib-E window does not offer them.
  clearInterval(heartbeat);
  heartbeat = window.setInterval(() => {
    for (const t of store.tabs) {
      if (!t.dirty || t.bookId || t.isSample) continue;
      void idbGet<RecoveryRecord>('recovery', `${t.id}:plan`)
        .then((r) => (r ? idbPut('recovery', `${t.id}:plan`, { ...r, alive: Date.now() }) : undefined))
        .catch(() => undefined);
    }
  }, 10_000);
  // Leaving the page: write what is pending.
  window.addEventListener('pagehide', () => void flushAll());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAll();
  });
}
