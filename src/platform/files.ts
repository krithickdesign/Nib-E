// Opening and saving files, wherever Nib-E runs:
//  - desktop app (Tauri): the system Open / Save windows; Nib-E can write back to
//    the file it opened. Only files the person picked (or opened with Nib-E) can be
//    read or written, enforced in src-tauri/src/lib.rs.
//  - Chrome / Edge: the same Open / Save windows through the File System Access API.
//  - Firefox / Safari: no Save window exists for web pages; files are downloaded
//    (to Downloads, or wherever the browser asks if "Always ask where to save" is on).
//  - claude.ai artifact preview: its "downloads" capability.
import { inFrame, invoke, isDesktop } from './env';

export type SaveResult = 'saved' | 'cancelled';

/** Where a document lives on disk, if Nib-E may write back to it. */
export type FileRef = { kind: 'fsa'; handle: FsHandle } | { kind: 'path'; path: string };

export interface FsHandle {
  name: string;
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: Blob | Uint8Array): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FsHandle): Promise<boolean>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

declare global {
  interface Window {
    claude?: { use(name: string): Promise<unknown> };
    showSaveFilePicker?: (opts: { suggestedName?: string; types?: PickerType[]; id?: string; startIn?: FsHandle | string }) => Promise<FsHandle>;
    showOpenFilePicker?: (opts: { multiple?: boolean; types?: PickerType[]; id?: string; excludeAcceptAllOption?: boolean }) => Promise<FsHandle[]>;
  }
}

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  ref: FileRef | null;
}

const PDF_TYPE: PickerType = { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } };

function typeFor(mime: string, ext: string): PickerType {
  if (mime === 'application/pdf') return PDF_TYPE;
  const label = mime === 'application/zip' ? 'ZIP archive' : mime === 'text/plain' ? 'Text file' : mime === 'application/json' ? 'Nib-E notes backup' : 'Image';
  return { description: label, accept: { [mime]: [ext] } };
}

let downloads: Promise<DownloadsApi | null> | null = null;

/** Start resolving the artifact capability early so Save is instant later. */
export function prepareSaving(): void {
  if (!downloads && window.claude?.use) {
    downloads = window.claude.use('downloads').then((d) => (d as DownloadsApi) ?? null).catch(() => null);
  }
}

/** True when this browser can show a Save window (desktop app, Chrome, Edge). */
export function hasSaveWindow(): boolean {
  return isDesktop() || (!!window.showSaveFilePicker && !inFrame());
}

/** True when Nib-E can write over a file it opened. */
export function canWriteBack(ref: FileRef | null): boolean {
  return !!ref && (ref.kind === 'path' || !inFrame());
}

/** A short label for where a file is, for messages ("Report.pdf" or the full path in the app). */
export function refLabel(ref: FileRef): string {
  return ref.kind === 'path' ? ref.path : ref.handle.name;
}

/** Same file on disk? */
export async function sameRef(a: FileRef | null, b: FileRef | null): Promise<boolean> {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'path' && b.kind === 'path') return a.path === b.path;
  if (a.kind === 'fsa' && b.kind === 'fsa') return a.handle === b.handle || ((await a.handle.isSameEntry?.(b.handle).catch(() => false)) ?? false);
  return false;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Reads a file the desktop app is allowed to open. */
export async function readPath(path: string): Promise<PickedFile> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return { name: fileName(path), bytes: new Uint8Array(buf), ref: { kind: 'path', path } };
}

/**
 * Shows the Open window. Returns null when this browser has none (the caller
 * then uses a plain <input type=file>, which gives no way to save back).
 */
export async function pickPdfs(multiple = true): Promise<PickedFile[] | null> {
  if (isDesktop()) {
    const paths = await invoke<string[]>('pick_open', { multiple });
    const out: PickedFile[] = [];
    for (const p of paths) out.push(await readPath(p));
    return out;
  }
  if (window.showOpenFilePicker && !inFrame()) {
    try {
      const handles = await window.showOpenFilePicker({ multiple, types: [PDF_TYPE], id: 'nib-pdf' });
      const out: PickedFile[] = [];
      for (const h of handles) {
        const f = await h.getFile();
        out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), ref: { kind: 'fsa', handle: h } });
      }
      return out;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return [];
      return null;
    }
  }
  return null;
}

/** File handles for files dropped on the window (Chrome / Edge). */
export async function droppedRefs(items: DataTransferItemList | undefined): Promise<(FileRef | null)[]> {
  const list = [...(items ?? [])].filter((i) => i.kind === 'file');
  return Promise.all(
    list.map(async (i) => {
      const get = (i as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FsHandle | null> }).getAsFileSystemHandle;
      if (!get || inFrame()) return null;
      try {
        const h = await get.call(i);
        return h && h.kind === 'file' ? ({ kind: 'fsa', handle: h } as FileRef) : null;
      } catch {
        return null;
      }
    }),
  );
}

/** Asks the browser for permission to write (Chrome asks once per file and visit). */
async function ensureWritable(h: FsHandle): Promise<boolean> {
  try {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    const r = await h.requestPermission?.({ mode: 'readwrite' });
    return r === undefined || r === 'granted';
  } catch {
    return true; // older Chrome: createWritable asks by itself
  }
}

/**
 * Writes bytes over a file. The browser writes to a temporary copy and swaps
 * it in on close; the desktop app writes "name.pdf.nib-tmp" and renames it.
 * Either way a failed write leaves the old file untouched.
 */
export async function writeRef(ref: FileRef, bytes: Uint8Array): Promise<void> {
  if (ref.kind === 'path') {
    await invoke('write_file', bytes, { headers: { 'x-nib-path': encodeURIComponent(ref.path) } });
    return;
  }
  if (!(await ensureWritable(ref.handle))) throw new Error('Nib-E was not allowed to change this file. Use Save as to save a copy.');
  const w = await ref.handle.createWritable();
  try {
    await w.write(new Blob([bytes as BlobPart]));
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => undefined);
    throw e;
  }
}

/** Reads the current bytes of a file on disk (for backups and checks). */
export async function readRef(ref: FileRef): Promise<Uint8Array | null> {
  try {
    if (ref.kind === 'path') return (await readPath(ref.path)).bytes;
    return new Uint8Array(await (await ref.handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

export interface SaveAsResult {
  status: SaveResult;
  /** Where it was written, when Nib-E can write there again (not for downloads). */
  ref: FileRef | null;
  name: string;
  /** The file went to the browser's downloads (no Save window here). */
  downloaded: boolean;
}

/** "Save as": the system Save window where there is one, a download otherwise. */
export async function saveAs(filename: string, bytes: Uint8Array, mime = 'application/pdf'): Promise<SaveAsResult> {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  if (isDesktop()) {
    const path = await invoke<string | null>('pick_save', { name: filename, ext: ext.replace('.', ''), label: typeFor(mime, ext).description });
    if (!path) return { status: 'cancelled', ref: null, name: filename, downloaded: false };
    const ref: FileRef = { kind: 'path', path };
    await writeRef(ref, bytes);
    return { status: 'saved', ref, name: fileName(path), downloaded: false };
  }

  prepareSaving();
  const api = downloads ? await downloads : null;
  if (api) {
    try {
      await api.save({ filename, data: new Blob([bytes as BlobPart], { type: mime }) });
      return { status: 'saved', ref: null, name: filename, downloaded: true };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'declined') return { status: 'cancelled', ref: null, name: filename, downloaded: false };
      if (code === 'rate_limited') throw new Error('A save prompt is already open.');
      throw new Error((e as Error)?.message || 'Saving is not available here.');
    }
  }

  if (window.showSaveFilePicker && !inFrame()) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [typeFor(mime, ext)], id: mime === 'application/pdf' ? 'nib-pdf' : 'nib-export' });
      const ref: FileRef = { kind: 'fsa', handle };
      await writeRef(ref, bytes);
      return { status: 'saved', ref, name: handle.name || filename, downloaded: false };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { status: 'cancelled', ref: null, name: filename, downloaded: false };
      // Anything else (blocked by policy, odd file system): fall back to a download.
    }
  }

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { status: 'saved', ref: null, name: filename, downloaded: true };
}

/** Saves a new file (exports, copies). */
export async function saveFile(filename: string, bytes: Uint8Array, mime = 'application/pdf'): Promise<SaveResult> {
  const r = await saveAs(filename, bytes, mime);
  if (r.downloaded) noteDownloaded();
  return r.status;
}

let onDownload: (() => void) | null = null;
/** Called after a file went to Downloads (shows the "choose a folder" tip once). */
export function setDownloadNotice(fn: () => void): void {
  onDownload = fn;
}
export function noteDownloaded(): void {
  onDownload?.();
}
