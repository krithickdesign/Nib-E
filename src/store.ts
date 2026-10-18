// App state with undo/redo. The plan (pages, notes, header/footer,
// watermark) is immutable, so a history step is just the previous plan.
import { HIGHLIGHT_COLORS, HIGHLIGHT_SIZES, PEN_COLORS, PEN_SIZES } from './ink/stroke';
import type { FontFamily, Item, PageEntry, Plan, Source, Template } from './model';
import type { CheckReport } from './pdf/check';
import type { DetectedField } from './pdf/detect';
import type { FileRef } from './platform/files';

export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'retype'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'sign'
  | 'mark'
  | 'note'
  | 'shape'
  | 'markup'
  | 'stamp'
  | 'image'
  | 'link'
  | 'redact'
  | 'field';

export type PanelView =
  | 'home'
  | 'edit'
  | 'fill'
  | 'form'
  | 'comment'
  | 'stamp'
  | 'redact'
  | 'organize'
  | 'combine'
  | 'compress'
  | 'protect'
  | 'export'
  | 'create'
  | 'study'
  | 'check'
  | 'attachments'
  | 'signatures'
  | 'printcheck'
  | 'ocr'
  | 'hf'
  | 'wm'
  | 'settings';

export interface DocState {
  name: string;
  primary: string;
  sources: Map<string, Source>;
  plan: Plan;
  reports: { sourceId: string; name: string; report: CheckReport }[];
  isSample: boolean;
  /** Detected fill-in places per source page: key `${src}:${index}`. */
  fields: Map<string, DetectedField[]>;
  /** Whether the opened file had real form fields. */
  hasForm: boolean;
  /** Tab identity (stays the same when redaction swaps the file underneath). */
  id: string;
  /** Detected boxes are only shown after the person says yes (null = not asked yet). */
  fieldsOn: boolean | null;
  /** Detection still running. */
  detecting: boolean;
  /** Name chosen by the person (rename) or by a redaction; Save uses it as is. */
  saveName: string | null;
  closed: boolean;
  /** Where Save writes: the opened file, or where "Save as" put it. null = Save asks. */
  file: FileRef | null;
  /** Study library record, when this file is studied with notes. */
  bookId: string | null;
  /** For study books: notes kept on this device (book file untouched) or written into the file. */
  keep: 'device' | 'file';
  /** Fingerprint of the opened bytes (finds the book's notes again on reopen). */
  print: string | null;
  // Per-tab working state.
  undo: Plan[];
  redo: Plan[];
  selected: Set<string>;
  current: number;
  dirty: boolean;
}

/** Fresh per-tab working state for a new document. */
export function tabState(): Pick<DocState, 'id' | 'fieldsOn' | 'detecting' | 'saveName' | 'closed' | 'file' | 'bookId' | 'keep' | 'print' | 'undo' | 'redo' | 'selected' | 'current' | 'dirty'> {
  return {
    id: `t${Math.random().toString(36).slice(2, 9)}`,
    fieldsOn: null,
    detecting: false,
    saveName: null,
    closed: false,
    file: null,
    bookId: null,
    keep: 'device',
    print: null,
    undo: [],
    redo: [],
    selected: new Set(),
    current: 0,
    dirty: false,
  };
}

/** More open files than this slow the browser down (each keeps its pages in memory). */
export const MAX_TABS = 8;

export interface Prefs {
  penColor: string;
  penSize: number;
  hlColor: string;
  hlSize: number;
  fingerDraws: boolean;
  /** How much the pen smooths writing. */
  penFeel: 'precise' | 'balanced' | 'smooth';
  textFont: FontFamily;
  textSize: number;
  textBold: boolean;
  textItalic: boolean;
  textColor: string;
  markShape: 'check' | 'cross' | 'dot';
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  shapeColor: string;
  shapeWidth: number;
  markup: 'highlight' | 'underline' | 'strike';
  markupColor: string;
  noteColor: string;
  stamp: { label: string; color: string };
  stampDate: boolean;
  fieldKind: 'text' | 'check';
  fillable: boolean;
  sanitize: boolean;
  rasterize: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Interface size: 1 = 100 %. */
  uiScale: number;
  spellcheck: boolean;
  /** Spelling language for typed text ('' = the browser's own). */
  spellLang: string;
  /** Keep the previous version when saving over a file (restorable from the Save menu). */
  keepBackup: boolean;
  /** Default for new study books: notes on this device, or inside the book file. */
  studyKeep: 'device' | 'file';
  /** Colour theme: follow the system, or always light / dark. */
  theme: 'system' | 'light' | 'dark';
  /** Change the font and size menus by pointing at them and scrolling. */
  wheelPick: boolean;
  /** Interface language ('auto' follows the system). */
  lang: import('./i18n').LangPref;
  /** Languages for text recognition (Tesseract codes). */
  ocrLangs: string[];
  /** Page layout: one page per row, two side by side, or two with the title page alone. */
  spread: 'single' | 'two' | 'cover';
}

export type Change =
  | 'doc'
  | 'pages'
  | 'notes'
  | 'items'
  | 'decor'
  | 'tool'
  | 'prefs'
  | 'zoom'
  | 'selection'
  | 'current'
  | 'history'
  | 'dirty'
  | 'fields'
  | 'formvalues'
  | 'panel'
  | 'mode'
  | 'editing'
  | 'tabs'
  | 'library'
  | 'file';

export interface Selection {
  key: string;
  id: string;
}

const PREFS_KEY = 'nib.prefs.v3';
const OLD_PREFS_KEY = 'nib.prefs.v2';

const BASE_PREFS: Prefs = {
  penColor: PEN_COLORS[1],
  penSize: PEN_SIZES[1],
  hlColor: HIGHLIGHT_COLORS[0],
  hlSize: HIGHLIGHT_SIZES[1],
  fingerDraws: true,
  penFeel: 'balanced',
  textFont: 'sans',
  textSize: 11,
  textBold: false,
  textItalic: false,
  textColor: '#1b1f2e',
  markShape: 'check',
  shape: 'rect',
  shapeColor: '#d62f3f',
  shapeWidth: 1.5,
  markup: 'highlight',
  markupColor: '#ffd84a',
  noteColor: '#ffd84a',
  stamp: { label: 'APPROVED', color: '#13804f' },
  stampDate: true,
  fieldKind: 'text',
  fillable: false,
  sanitize: true,
  rasterize: false,
  leftOpen: true,
  rightOpen: true,
  uiScale: 1.5,
  spellcheck: true,
  spellLang: '',
  keepBackup: true,
  studyKeep: 'device',
  theme: 'system',
  wheelPick: true,
  lang: 'auto',
  ocrLangs: ['eng'],
  spread: 'single',
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...BASE_PREFS, ...JSON.parse(raw) };
    // From v0.2: keep pens, colours and panels; drop settings whose meaning changed.
    const old = localStorage.getItem(OLD_PREFS_KEY);
    if (old) {
      const o = JSON.parse(old);
      for (const k of ['showFields', 'includeNotes', 'noteTemplate']) delete o[k];
      return { ...BASE_PREFS, ...o };
    }
  } catch {
    /* storage unavailable */
  }
  return { ...BASE_PREFS };
}

type Listener = (why: Change) => void;

class Store {
  /** Open documents, in tab order. */
  tabs: DocState[] = [];
  doc: DocState | null = null;
  tool: Tool = 'pen';
  prefs: Prefs = loadPrefs();
  zoom = 1;
  fitMode: 'width' | 'page' | null = 'width';
  penSeen = false;
  sel: Selection | null = null;
  editing: Selection | null = null;
  panel: PanelView = 'home';
  study = false;
  fullpage = false;
  /** Image waiting to be placed with the image tool. */
  pendingImage: string | null = null;
  /** Largest side of that image when placed, in points (stamps are smaller). */
  pendingImageSize = 220;
  private listeners = new Set<Listener>();
  private noSel = new Set<string>();

  // Per-tab state, read through the active tab.
  get selected(): Set<string> {
    return this.doc?.selected ?? this.noSel;
  }
  get current(): number {
    return this.doc?.current ?? 0;
  }
  set current(i: number) {
    if (this.doc) this.doc.current = i;
  }
  get dirty(): boolean {
    return this.doc?.dirty ?? false;
  }
  set dirty(v: boolean) {
    if (this.doc) this.doc.dirty = v;
  }
  private get undoStack(): Plan[] {
    return this.doc?.undo ?? [];
  }
  private get redoStack(): Plan[] {
    return this.doc?.redo ?? [];
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(why: Change): void {
    for (const fn of this.listeners) fn(why);
  }

  // ---------- tabs ----------

  /** Shows another open document. */
  activate(doc: DocState | null): void {
    if (doc === this.doc) return;
    this.doc = doc;
    this.sel = null;
    this.editing = null;
    this.pendingImage = null;
    this.emit('doc');
    this.emit('tabs');
  }

  /** Adds a document as a new tab (after the active one) and shows it. */
  addTab(doc: DocState): void {
    const at = this.doc ? this.tabs.indexOf(this.doc) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, doc);
    this.activate(doc);
    this.emit('tabs');
  }

  /** Puts `next` in the place of `old` (same tab position, keeps the tab id). */
  replaceTab(old: DocState, next: DocState): void {
    const i = this.tabs.indexOf(old);
    next.id = old.id;
    if (i >= 0) this.tabs[i] = next;
    else this.tabs.push(next);
    old.closed = true;
    if (this.doc === old) {
      this.doc = null;
      this.activate(next);
    }
    this.emit('tabs');
  }

  /** Removes a tab; shows its neighbour if it was the active one. */
  removeTab(doc: DocState): void {
    const i = this.tabs.indexOf(doc);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    doc.closed = true;
    if (this.doc === doc) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    this.emit('tabs');
  }

  /** Changes the document's name (and the name Save uses). */
  rename(doc: DocState, name: string): void {
    doc.name = name;
    doc.saveName = name;
    this.emit('tabs');
    if (doc === this.doc && (doc.plan.hf || doc.plan.wm)) this.emit('decor');
  }

  get plan(): Plan {
    return this.doc?.plan ?? { pages: [], notes: [], hf: null, wm: null };
  }

  get pages(): PageEntry[] {
    return this.plan.pages;
  }

  get notes(): PageEntry[] {
    return this.plan.notes;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Replace the plan as one undoable step. */
  commit(next: Partial<Plan>, why: Change = 'items'): void {
    if (!this.doc) return;
    this.undoStack.push(this.doc.plan);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.doc.redo = [];
    this.doc.plan = { ...this.doc.plan, ...next };
    this.afterChange();
    this.emit(why);
    this.emit('history');
  }

  undo(): void {
    if (!this.doc || !this.undoStack.length) return;
    this.redoStack.push(this.doc.plan);
    this.doc.plan = this.undoStack.pop()!;
    this.afterJump();
  }

  redo(): void {
    if (!this.doc || !this.redoStack.length) return;
    this.undoStack.push(this.doc.plan);
    this.doc.plan = this.redoStack.pop()!;
    this.afterJump();
  }

  private afterChange(): void {
    const keys = new Set(this.pages.map((p) => p.key));
    for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
    if (this.sel && !this.findItem(this.sel.key, this.sel.id)) this.sel = null;
    const was = this.dirty;
    this.dirty = true;
    if (!was) this.emit('tabs');
  }

  private afterJump(): void {
    this.afterChange();
    this.current = Math.min(this.current, Math.max(0, this.pages.length - 1));
    this.emit('pages');
    this.emit('notes');
    this.emit('decor');
    this.emit('selection');
    this.emit('history');
  }

  /** Replaces a document's plan without an undo step (restoring kept notes or unsaved work). */
  restorePlan(doc: DocState, plan: Plan, current = 0): void {
    doc.plan = plan;
    doc.undo = [];
    doc.redo = [];
    doc.current = Math.min(Math.max(0, current), Math.max(0, plan.pages.length - 1));
    if (doc !== this.doc) return;
    this.sel = null;
    this.emit('pages');
    this.emit('notes');
    this.emit('decor');
    this.emit('selection');
    this.emit('history');
    this.emit('current');
  }

  markSaved(doc: DocState | null = this.doc): void {
    if (!doc) return;
    doc.dirty = false;
    this.emit('dirty');
    this.emit('tabs');
  }

  // ---------- lookup ----------

  findPage(key: string): { page: PageEntry; list: 'pages' | 'notes'; index: number } | null {
    let i = this.pages.findIndex((p) => p.key === key);
    if (i >= 0) return { page: this.pages[i], list: 'pages', index: i };
    i = this.notes.findIndex((p) => p.key === key);
    if (i >= 0) return { page: this.notes[i], list: 'notes', index: i };
    return null;
  }

  findItem(key: string, id: string): Item | null {
    return this.findPage(key)?.page.items.find((it) => it.id === id) ?? null;
  }

  /** Detected boxes on a page; none until the person turned them on for this file. */
  fieldsFor(p: PageEntry): DetectedField[] {
    if (p.src === null || !this.doc || !this.doc.fieldsOn) return [];
    return this.doc.fields.get(`${p.src}:${p.index}`) ?? [];
  }

  /** Turns the detected boxes of the active file on or off. */
  setFieldsOn(on: boolean): void {
    if (!this.doc) return;
    this.doc.fieldsOn = on;
    this.emit('fields');
  }

  // ---------- item edits ----------

  updatePage(key: string, fn: (p: PageEntry) => PageEntry, why: Change = 'items'): void {
    const hit = this.findPage(key);
    if (!hit) return;
    const list = hit.list === 'pages' ? [...this.pages] : [...this.notes];
    list[hit.index] = fn(hit.page);
    this.commit(hit.list === 'pages' ? { pages: list } : { notes: list }, why);
  }

  addItems(key: string, items: Item[]): void {
    this.updatePage(key, (p) => ({ ...p, items: [...p.items, ...items] }));
  }

  replaceItem(key: string, item: Item): void {
    this.updatePage(key, (p) => ({ ...p, items: p.items.map((it) => (it.id === item.id ? item : it)) }));
  }

  removeItems(key: string, ids: Set<string>): void {
    if (!ids.size) return;
    this.updatePage(key, (p) => ({ ...p, items: p.items.filter((it) => !ids.has(it.id)) }));
  }

  /** Several pages at once, as one undo step. */
  updatePages(fn: (p: PageEntry) => PageEntry): void {
    this.commit({ pages: this.pages.map(fn), notes: this.notes.map(fn) });
  }

  select(sel: Selection | null): void {
    this.sel = sel;
    this.emit('selection');
  }

  setEditing(sel: Selection | null): void {
    this.editing = sel;
    this.emit('editing');
  }

  // ---------- tools and prefs ----------

  setTool(t: Tool): void {
    if (this.tool === t) return;
    this.tool = t;
    if (t !== 'select' && t !== 'text' && t !== 'retype') this.select(null);
    this.emit('tool');
  }

  setPrefs(p: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...p };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable */
    }
    this.emit('prefs');
  }

  setPanel(v: PanelView): void {
    this.panel = v;
    if (!this.prefs.rightOpen) this.setPrefs({ rightOpen: true });
    this.emit('panel');
  }

  setZoom(z: number, fit: 'width' | 'page' | null = null): void {
    const next = Math.min(6, Math.max(0.2, z));
    if (Math.abs(next - this.zoom) < 1e-4 && fit === this.fitMode) return;
    this.zoom = next;
    this.fitMode = fit;
    this.emit('zoom');
  }

  setCurrent(i: number): void {
    if (i === this.current) return;
    this.current = i;
    this.emit('current');
  }

  setStudy(on: boolean): void {
    if (this.study === on) return;
    this.study = on;
    this.emit('mode');
  }

  setFullpage(on: boolean): void {
    if (on && !this.doc) return;
    if (this.fullpage === on) return;
    this.fullpage = on;
    this.emit('mode');
  }

  // ---------- page edits ----------

  /** Keys the page actions apply to: the selection, or the current page. */
  targetKeys(): string[] {
    if (this.selected.size) return this.pages.filter((p) => this.selected.has(p.key)).map((p) => p.key);
    const p = this.pages[this.current];
    return p ? [p.key] : [];
  }

  rotate(keys: string[], dir: 1 | -1): void {
    const set = new Set(keys);
    this.commit({ pages: this.pages.map((p) => (set.has(p.key) ? { ...p, rot: ((((p.rot + dir) % 4) + 4) % 4) as PageEntry['rot'] } : p)) }, 'pages');
  }

  remove(keys: string[]): void {
    const set = new Set(keys);
    this.commit({ pages: this.pages.filter((p) => !set.has(p.key)) }, 'pages');
  }

  shift(keys: string[], dir: 1 | -1): void {
    const set = new Set(keys);
    const list = [...this.pages];
    const idx = list.map((p, i) => (set.has(p.key) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    if (dir < 0 && idx[0] === 0) return;
    if (dir > 0 && idx[idx.length - 1] === list.length - 1) return;
    const order = dir < 0 ? idx : [...idx].reverse();
    for (const i of order) [list[i], list[i + dir]] = [list[i + dir], list[i]];
    this.commit({ pages: list }, 'pages');
    this.current = Math.max(0, Math.min(list.length - 1, this.current + dir));
    this.emit('current');
  }

  moveTo(keys: string[], beforeKey: string | null): void {
    const set = new Set(keys);
    const moving = this.pages.filter((p) => set.has(p.key));
    const rest = this.pages.filter((p) => !set.has(p.key));
    let at = beforeKey ? rest.findIndex((p) => p.key === beforeKey) : rest.length;
    if (at < 0) at = rest.length;
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((p, i) => p === this.pages[i])) return;
    this.commit({ pages: next }, 'pages');
  }

  insertBlank(after: number, template: Template, w: number, h: number, key: string): void {
    const page: PageEntry = { key, src: null, index: 0, w, h, baseRot: 0, rot: 0, template, items: [] };
    const next = [...this.pages];
    next.splice(after + 1, 0, page);
    this.commit({ pages: next }, 'pages');
  }

  appendPages(entries: PageEntry[]): void {
    this.commit({ pages: [...this.pages, ...entries] }, 'pages');
  }

  addNote(template: Template, key: string, opts: { quiet?: boolean } = {}): void {
    const page: PageEntry = { key, src: null, index: 0, w: 595.28, h: 841.89, baseRot: 0, rot: 0, template, items: [] };
    if (opts.quiet && this.doc) {
      // The first empty page of a notebook is not an edit (no undo step, no "unsaved").
      this.doc.plan = { ...this.doc.plan, notes: [...this.notes, page] };
      this.emit('notes');
      return;
    }
    this.commit({ notes: [...this.notes, page] }, 'notes');
  }

  /** Changes the ruling of one note page. */
  setNoteTemplate(key: string, template: Template): void {
    const hit = this.findPage(key);
    if (!hit || hit.list !== 'notes' || hit.page.template === template) return;
    const empty = !hit.page.items.length && this.notes.length === 1 && !this.doc!.undo.length;
    if (empty) {
      // Still the untouched first page: switching its ruling is not an edit either.
      this.doc!.plan = { ...this.doc!.plan, notes: [{ ...hit.page, template }] };
      this.emit('notes');
      return;
    }
    this.updatePage(key, (p) => ({ ...p, template }), 'notes');
  }

  removeNote(key: string): void {
    this.commit({ notes: this.notes.filter((p) => p.key !== key) }, 'notes');
  }
}

export const store = new Store();
