import '@fontsource/hanken-grotesk/latin-400.css';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import './styles.css';
import {
  Cancelled,
  cleanName,
  closeDoc,
  exportPdf,
  fieldCount,
  mergeBytes,
  mergeFile,
  openBytes,
  pendingRedactions,
  redactNow,
  setOpenHook,
  setPasswordAsker,
  TooManyTabs,
} from './doc';
import { afterOpen, discardRecovery, dropRecovery, flush, flushAll, listBooks, pendingRecovery, restoreRecovery, setRecoveryIdle, setRestoreNotice, startAutosave } from './library';
import { uid, type Template } from './model';
import { startPdfium } from './pdf/pdfium';
import { checkImages } from './pdf/verify';
import { invoke, isDesktop, listen } from './platform/env';
import { droppedRefs, hasSaveWindow, pickPdfs, prepareSaving, readPath, setDownloadNotice, type FileRef } from './platform/files';
import { exportBackup, exportFlattened, exportNotesOnly, exportText, exportWithNotes, printDoc, restoreBackup, saveDoc, saveDocAs } from './saving';
import { LibraryView } from './ui/libraryview';
import { askPrint, saveHint, SaveMenu, type MenuAction } from './ui/savemenu';
import { HelpMenu } from './ui/helpmenu';
import { APP_NAME, landingUrl } from './config';
import { MAX_TABS, store, type DocState, type Tool } from './store';
import { ContextBar } from './ui/contextbar';
import { ask } from './ui/dialog';
import { Dock } from './ui/dock';
import { helpSeen, openHelp } from './ui/help';
import { icon } from './ui/icons';
import { Sidebar } from './ui/sidebar';
import { myStamps, useStamp } from './ui/stamps';
import { ToolPanel } from './ui/toolpanel';
import { toast } from './ui/toast';
import { Viewer } from './ui/viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let busy = false;
async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) return undefined;
  busy = true;
  app.classList.add('busy');
  const saveBtn = $('btn-save');
  const old = saveBtn.innerHTML;
  saveBtn.innerHTML = `${icon('save')}<span class="btn-label">${label}</span>`;
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TooManyTabs) toast(e.message, 'error', 7000);
    else if (!(e instanceof Cancelled)) {
      console.error(e);
      toast((e as Error)?.message || 'Something went wrong.', 'error', 7000);
    }
    return undefined;
  } finally {
    busy = false;
    app.classList.remove('busy');
    saveBtn.innerHTML = old;
  }
}

let viewer: Viewer;
let notebook: Viewer;
let panel: ToolPanel;
let saveMenu: SaveMenu;

/** The viewer that holds the current selection or edit, if any. */
function activeViewer(): Viewer {
  const key = store.sel?.key;
  return key && notebook.hasCard(key) ? notebook : viewer;
}

// ---------- chrome ----------

function setupChrome(): void {
  $('brand-mark').innerHTML = icon('nib');
  $('boot-mark').innerHTML = icon('nib');
  const label = (id: string, ic: string, text: string, title: string) => {
    $(id).innerHTML = `${icon(ic)}<span class="btn-label">${text}</span>`;
    $(id).title = title;
  };
  label('btn-open', 'open', 'Open', 'Open a PDF in a new tab (Ctrl+O)');
  label('btn-merge', 'addfile', 'Add PDF', 'Add pages from another PDF to the end of this one');
  label('btn-save', 'save', 'Save', 'Save as PDF (Ctrl+S)');
  label('btn-study', 'study', 'Study', 'Study mode: PDF beside a notebook');
  label('btn-full', 'fullscreen', 'Full page', 'Full page (F)');
  label('btn-tools', 'tools', 'Toolbox', 'Show or hide the toolbox');
  label('btn-help', 'help', 'Help', 'Help, shortcuts and feedback');
  $('exit-full').innerHTML = `${icon('exitFull')}<span>Exit full page</span>`;
  $('full-study').innerHTML = `${icon('study')}<span>Notes</span>`;
  $('full-study').title = 'Show or hide the notebook';
  $('nb-icon').innerHTML = icon('study');
  $('nb-add').innerHTML = `${icon('plus')}<span>Page</span>`;
  $('nb-add').title = 'Add a note page';

  $('btn-open').addEventListener('click', () => void openDialog());
  $('btn-merge').addEventListener('click', () => $('file-merge').click());
  $('btn-save').addEventListener('click', () => void save());
  $('btn-save-menu').innerHTML = icon('chevD');
  $('btn-save-menu').title = 'More ways to save, export and print';
  $('btn-save-menu').setAttribute('aria-label', 'Save options');
  $('btn-save-menu').setAttribute('aria-haspopup', 'menu');
  $('btn-save-menu').setAttribute('aria-expanded', 'false');
  saveMenu = new SaveMenu($('btn-save-menu'), $('save-menu'), (a) => void menuAction(a));
  $('btn-save-menu').addEventListener('click', () => saveMenu.toggle());
  $('btn-study').addEventListener('click', () => store.setStudy(!store.study));
  $('btn-full').addEventListener('click', () => store.setFullpage(true));
  $('btn-tools').addEventListener('click', () => store.setPrefs({ rightOpen: !store.prefs.rightOpen }));
  const helpMenu = new HelpMenu($('btn-help'), $('help-menu'));
  $('btn-help').setAttribute('aria-haspopup', 'menu');
  $('btn-help').setAttribute('aria-expanded', 'false');
  $('btn-help').addEventListener('click', () => helpMenu.toggle());
  // The logo opens the start page in a new window (or tab), next to the open files.
  const brand = document.querySelector('.brand') as HTMLElement;
  brand.setAttribute('role', 'button');
  brand.tabIndex = 0;
  // Web: the Nib-E website's landing page. Desktop app and the single offline
  // file have no landing page, so they open a fresh Nib-E start screen.
  const landing = isDesktop() ? null : landingUrl(location.href);
  brand.title = landing ? `${APP_NAME} home page (new tab)` : `New ${APP_NAME} ${isDesktop() ? 'window' : 'tab'}`;
  const openStart = () => {
    if (isDesktop()) void invoke('new_window').catch((e) => toast(String(e), 'error'));
    else window.open(landing ?? location.href.split('#')[0], '_blank');
  };
  brand.addEventListener('click', openStart);
  brand.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openStart();
    }
  });
  $('exit-full').addEventListener('click', () => store.setFullpage(false));
  $('full-study').addEventListener('click', () => store.setStudy(!store.study));
  $('btn-check').addEventListener('click', () => store.setPanel(store.panel === 'check' && store.prefs.rightOpen ? 'home' : 'check'));
  $('nb-add').addEventListener('click', () => {
    const last = store.notes[store.notes.length - 1];
    store.addNote(last?.template ?? 'lined', uid('n'));
    requestAnimationFrame(() => notebook.scrollToEnd());
  });

  $<HTMLInputElement>('file-open').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    void openMany(files);
  });
  $<HTMLInputElement>('file-merge').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void merge(files);
  });

  // Side panels collapse with the arrow tabs on their inner edge.
  $('edge-left').addEventListener('click', () => store.setPrefs({ leftOpen: !store.prefs.leftOpen }));
  $('edge-right').addEventListener('click', () => store.setPrefs({ rightOpen: !store.prefs.rightOpen }));
  if (window.matchMedia('(max-width: 760px)').matches || isPhone() || viewW() < 1100) store.setPrefs({ leftOpen: false, rightOpen: false });
  // Phones show study mode as two tabs: the PDF or the notebook.
  $('study-tabs').innerHTML = `<button type="button" data-side="pdf" aria-pressed="true">${icon('open')}<span>PDF</span></button><button type="button" data-side="notes" aria-pressed="false">${icon('study')}<span>Notes</span></button>`;
  $('study-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-side]') as HTMLElement | null;
    if (!b) return;
    const notes = b.dataset.side === 'notes';
    app.classList.toggle('nb-front', notes);
    for (const x of $('study-tabs').querySelectorAll('[data-side]')) x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.side === b.dataset.side));
    requestAnimationFrame(() => (notes ? notebook : viewer).fit('width'));
  });

  $('empty').innerHTML = `
    <span class="brand-mark big">${icon('nib')}</span>
    <h2>No file open</h2>
    <p>Open a PDF or drop one anywhere on this window. It stays on your device.</p>
    <div class="btn-row"><button class="btn btn-primary" type="button" data-a="open">${icon('open')}Open a PDF</button></div>
    <div class="library" id="library"></div>`;
  $('empty').addEventListener('click', (e) => {
    const a = ((e.target as HTMLElement).closest('[data-a]') as HTMLElement | null)?.dataset.a;
    if (a === 'open') void openDialog();
  });
}

let appliedUi = 0;

/** Layout viewport size (not affected by pinch zoom or page overflow on phones). */
function viewW(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}
function viewH(): number {
  return document.documentElement.clientHeight || window.innerHeight;
}

/** A phone: small screen in both directions, or a narrow portrait one. */
function isPhone(): boolean {
  return window.matchMedia('(max-width: 599px), (max-height: 599px)').matches;
}

/** Interface size. Phones get 100 %, tablets at most a little extra. */
function applyUiScale(): void {
  const want = store.prefs.uiScale || 1;
  const phone = isPhone();
  const small = !phone && (Math.min(viewW(), viewH()) < 820 || viewW() < 900);
  const ui = phone ? 1 : small ? Math.min(want, 1.15) : want;
  document.documentElement.style.setProperty('--ui', String(ui));
  app.classList.toggle('phone', phone);
  // Top bar breakpoints in interface units (see styles.css "narrow top bar").
  const eff = viewW() / ui;
  for (const w of [1180, 960, 700, 440]) app.classList.toggle(`tb-${w}`, eff <= w);
  const changed = ui !== appliedUi;
  appliedUi = ui;
  // Big interface on a narrow window: hide the page thumbnails to leave room for
  // the page (the arrow tab brings them back).
  if (changed && !phone && !small && store.prefs.leftOpen) {
    const left = viewW() - (212 + (store.prefs.rightOpen ? 316 : 0)) * ui;
    if (left < 700) store.setPrefs({ leftOpen: false });
  }
}

/** Light / dark: follow the system unless chosen in Settings. */
function applyTheme(): void {
  const t = store.prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function renderLayout(): void {
  const p = store.prefs;
  app.classList.toggle('left-closed', !p.leftOpen);
  app.classList.toggle('right-closed', !p.rightOpen);
  app.classList.toggle('study', store.study);
  if (!store.study && app.classList.contains('nb-front')) {
    app.classList.remove('nb-front');
    for (const x of $('study-tabs').querySelectorAll('[data-side]')) x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.side === 'pdf'));
  }
  app.classList.toggle('fullpage', store.fullpage);
  app.classList.toggle('no-doc', !store.doc);
  $('edge-left').innerHTML = icon(p.leftOpen ? 'chevL' : 'chevR');
  $('edge-left').title = p.leftOpen ? 'Hide pages' : 'Show pages';
  $('edge-left').setAttribute('aria-label', $('edge-left').title);
  $('edge-right').innerHTML = icon(p.rightOpen ? 'chevR' : 'chevL');
  $('edge-right').title = p.rightOpen ? 'Hide tools' : 'Show tools';
  $('edge-right').setAttribute('aria-label', $('edge-right').title);
  $('btn-study').setAttribute('aria-pressed', String(store.study));
  $('full-study').setAttribute('aria-pressed', String(store.study));
  $('btn-tools').setAttribute('aria-pressed', String(p.rightOpen));
  // Without a file there is nothing to save, study or show full page.
  for (const id of ['btn-save', 'btn-merge', 'btn-study', 'btn-full']) ($(id) as HTMLButtonElement).disabled = !store.doc;
  $('nb-count').textContent = `${store.notes.length} page${store.notes.length === 1 ? '' : 's'}`;
  $('empty').hidden = !!store.doc;
}

// ---------- notebook page ruling ----------

function renderNotebookBar(): void {
  const key = notebook.visibleKey();
  const page = key ? store.notes.find((p) => p.key === key) : undefined;
  const cur = page?.template ?? 'lined';
  $('nb-tpl').innerHTML = (['lined', 'grid', 'blank'] as Template[])
    .map((t) => `<button type="button" class="nb-tpl-btn" data-tpl="${t}" aria-pressed="${cur === t}" title="${t[0].toUpperCase() + t.slice(1)} page">${icon(t === 'blank' ? 'blank' : t === 'lined' ? 'lines' : 'grid')}<span>${t[0].toUpperCase() + t.slice(1)}</span></button>`)
    .join('');
}

function setupNotebookBar(): void {
  $('nb-tpl').setAttribute('role', 'group');
  $('nb-tpl').setAttribute('aria-label', 'Page ruling');
  $('nb-tpl').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-tpl]') as HTMLElement | null;
    if (!b) return;
    if (!store.notes.length) store.addNote(b.dataset.tpl as Template, uid('n'), { quiet: true });
    const key = notebook.visibleKey();
    if (key) store.setNoteTemplate(key, b.dataset.tpl as Template);
    renderNotebookBar();
  });
  let raf = 0;
  $('nb-viewer').addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderNotebookBar();
      });
    },
    { passive: true },
  );
  store.on((why) => {
    if (why === 'notes' || why === 'doc' || why === 'mode') requestAnimationFrame(renderNotebookBar);
  });
  renderNotebookBar();
}

function setupLayout(): void {
  store.on((why) => {
    if (why === 'prefs' || why === 'mode' || why === 'notes' || why === 'doc' || why === 'tabs') renderLayout();
    if (why === 'prefs') {
      applyUiScale();
      applyTheme();
    }
    if (why === 'doc' && !store.doc && store.fullpage) store.setFullpage(false);
    if ((why === 'mode' || why === 'doc') && store.study && store.doc && !store.notes.length) {
      // A fresh notebook starts with one lined page.
      store.addNote('lined', uid('n'), { quiet: true });
    }
    if (why === 'mode') {
      if (store.fullpage) {
        document.documentElement.requestFullscreen?.().catch(() => undefined);
        requestAnimationFrame(() => viewer.fit('page'));
      } else {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        requestAnimationFrame(() => viewer.fit('width'));
      }
      if (store.study) requestAnimationFrame(() => notebook.fit('width'));
    }
  });
  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = window.setTimeout(() => {
      appliedUi = 0;
      applyUiScale();
    }, 200);
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && store.fullpage) store.setFullpage(false);
  });
  // Notebook splitter.
  const split = $('splitter');
  let dragging = false;
  split.addEventListener('pointerdown', (e) => {
    dragging = true;
    split.setPointerCapture(e.pointerId);
  });
  split.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = $('panes').getBoundingClientRect();
    const frac = Math.min(0.75, Math.max(0.25, (e.clientX - r.left) / r.width));
    // On the work area, so the full-page buttons can line up with the PDF pane too.
    $('work').style.setProperty('--split', `${frac * 100}%`);
  });
  split.addEventListener('pointerup', () => {
    dragging = false;
    viewer.fit('width');
    notebook.fit('width');
  });
  applyUiScale();
  applyTheme();
  renderLayout();
}

// ---------- document name, tabs ----------

function setupMeta(): void {
  const render = () => {
    const doc = store.doc;
    const nameEl = $('docname');
    if (!nameEl.querySelector('input')) nameEl.textContent = doc ? doc.name : 'No file open';
    nameEl.title = doc ? `${doc.name} · double-click to rename` : '';
    const n = store.pages.length;
    const kept = doc?.bookId && doc.keep === 'device';
    $('docmeta').innerHTML = doc
      ? `<span class="mono">${n ? store.current + 1 : 0} / ${n}</span>${kept ? `<span class="kept" title="Study book: your marks and notes are saved on this device as you write. The book file is not changed.">${icon('check')}Notes kept</span>` : store.dirty ? '<span class="dirty" title="Unsaved changes">Edited</span>' : ''}${doc.isSample ? '<span class="tag">Sample</span>' : ''}`
      : '';
    $('btn-save').title = doc ? `Save (Ctrl+S): ${saveHint(doc)}` : 'Save (Ctrl+S)';
    const blocked = (doc?.reports ?? []).reduce((k, r) => k + r.report.findings.filter((f) => f.level === 'blocked').length, 0);
    const chip = $('btn-check');
    chip.classList.toggle('alert', blocked > 0);
    chip.innerHTML = `${icon(blocked ? 'shieldAlert' : 'shield')}<span class="chip-label">Safe mode</span>${blocked ? `<span class="chip-count">${blocked} blocked</span>` : ''}`;
    chip.title = blocked ? `${blocked} risky item${blocked > 1 ? 's' : ''} blocked. Open the document check.` : 'Safe mode is on. Open the document check.';
  };
  store.on((why) => {
    if (why === 'doc' || why === 'pages' || why === 'items' || why === 'current' || why === 'dirty' || why === 'history' || why === 'decor' || why === 'tabs' || why === 'library' || why === 'file') render();
  });
  $('docname').addEventListener('dblclick', () => startRename());
  $('docname').addEventListener('keydown', (e) => {
    if (e.key === 'F2' || e.key === 'Enter') startRename();
  });
  render();
}

/** Turns the file name at the top into a text box. Enter keeps, Esc cancels. */
function startRename(doc: DocState | null = store.doc): void {
  if (!doc) return;
  if (doc !== store.doc) store.activate(doc);
  const el = $('docname');
  if (el.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'docname-input';
  input.value = doc.name.replace(/\.pdf$/i, '');
  input.setAttribute('aria-label', 'File name');
  input.spellcheck = false;
  el.textContent = '';
  el.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const name = cleanName(input.value);
    input.remove();
    el.textContent = doc.name;
    if (keep && name && name !== doc.name) {
      store.rename(doc, name);
      toast(`Renamed. Save uses “${name}”.`, 'ok');
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renderTabs(): void {
  const bar = $('tabbar');
  const many = store.tabs.length > 1;
  app.classList.toggle('has-tabs', many);
  if (!many) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML =
    store.tabs
      .map((t) => {
        const on = t === store.doc;
        const unsaved = t.dirty && !(t.bookId && t.keep === 'device');
        return `<div class="tab${on ? ' on' : ''}${unsaved ? ' dirty' : ''}" role="tab" aria-selected="${on}" data-tab="${t.id}">
          <button type="button" class="tab-main" data-open="${t.id}" title="${esc(t.name)}${unsaved ? ' · unsaved changes' : t.bookId && t.keep === 'device' ? ' · notes kept on this device' : ''}"><span class="tab-dot" aria-hidden="true"></span><span class="tab-name">${esc(t.name.replace(/\.pdf$/i, ''))}</span></button>
          <button type="button" class="tab-x" data-close="${t.id}" aria-label="Close ${esc(t.name)}" title="Close">${icon('close')}</button>
        </div>`;
      })
      .join('') +
    `<button type="button" class="tab-new" data-new="1" title="Open another PDF" aria-label="Open another PDF">${icon('plus')}</button><span class="tab-count">${store.tabs.length}/${MAX_TABS}</span>`;
}

function setupTabs(): void {
  const bar = $('tabbar');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Open files');
  const byId = (id?: string) => store.tabs.find((t) => t.id === id);
  bar.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const close = (el.closest('[data-close]') as HTMLElement | null)?.dataset.close;
    if (close) return void closeTab(byId(close)!);
    const open = (el.closest('[data-open]') as HTMLElement | null)?.dataset.open;
    if (open) return store.activate(byId(open) ?? null);
    if (el.closest('[data-new]')) $('file-open').click();
  });
  bar.addEventListener('dblclick', (e) => {
    const open = ((e.target as HTMLElement).closest('[data-open]') as HTMLElement | null)?.dataset.open;
    if (open) startRename(byId(open));
  });
  // Middle click closes a tab, as in browsers.
  bar.addEventListener('auxclick', (e) => {
    const id = ((e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null)?.dataset.tab;
    if (e.button === 1 && id) {
      e.preventDefault();
      void closeTab(byId(id)!);
    }
  });
  store.on((why) => {
    if (why === 'tabs' || why === 'doc' || why === 'dirty') renderTabs();
  });
  renderTabs();
}

/** Closes a tab; asks first when it has unsaved changes. */
async function closeTab(doc: DocState | undefined): Promise<boolean> {
  if (!doc) return false;
  if (doc.bookId && doc.keep === 'device') {
    // Study book: everything is already kept on this device.
    await flush(doc);
  } else if (doc.dirty && !doc.isSample) {
    store.activate(doc);
    const res = await ask({
      title: `Save changes to “${doc.name}”?`,
      body: '<p>If you close without saving, your changes to this file are lost.</p>',
      actions: [
        { label: 'Cancel', value: 'cancel', kind: 'quiet' },
        { label: "Don't save", value: 'discard' },
        { label: 'Save', value: 'save', kind: 'primary' },
      ],
    });
    if (!res || res.value === 'cancel') return false;
    if (res.value === 'save' && !(await save())) return false;
  }
  closeDoc(doc);
  void dropRecovery(doc);
  return true;
}

/** Tabs whose changes would be lost (study books on this device are always kept). */
function unsavedTabs(): DocState[] {
  return store.tabs.filter((t) => t.dirty && !t.isSample && !(t.bookId && t.keep === 'device'));
}

// ---------- open / merge / save ----------

/** Open button / Ctrl+O: the system Open window where there is one. */
async function openDialog(): Promise<void> {
  let picked;
  try {
    picked = await pickPdfs(true);
  } catch (e) {
    toast((e as Error)?.message || 'Could not open the file.', 'error');
    return;
  }
  if (picked === null) {
    $('file-open').click();
    return;
  }
  for (const f of picked) {
    const state = await withBusy('Opening…', () => openBytes(f.name, f.bytes, { ref: f.ref }));
    if (!state) break;
    afterOpened();
  }
}

async function openMany(files: File[], refs: (FileRef | null)[] = []): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      toast(`${f.name} is not a PDF.`, 'error');
      continue;
    }
    const state = await withBusy('Opening…', async () => openBytes(f.name, new Uint8Array(await f.arrayBuffer()), { ref: refs[i] ?? null }));
    if (!state) break;
    afterOpened();
  }
}

/** Files opened by path in the desktop app (Open with…, drag and drop, double-click). */
async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!/\.pdf$/i.test(p)) {
      toast(`${p.split(/[\\/]/).pop()} is not a PDF.`, 'error');
      continue;
    }
    const state = await withBusy('Opening…', async () => {
      const f = await readPath(p);
      return openBytes(f.name, f.bytes, { ref: f.ref });
    });
    if (!state) break;
    afterOpened();
  }
}

async function merge(files: File[]): Promise<void> {
  for (const f of files) {
    const n = await withBusy('Adding…', () => mergeFile(f));
    if (n) toast(`Added ${n} page${n === 1 ? '' : 's'} from ${f.name}.`, 'ok');
  }
}

function afterOpened(): void {
  const blocked = (store.doc?.reports ?? []).reduce((n, r) => n + r.report.findings.filter((f) => f.level === 'blocked').length, 0);
  if (blocked) {
    store.setPanel('check');
    toast(`Safe mode blocked ${blocked} risky item${blocked > 1 ? 's' : ''} in this file.`, 'info', 6000);
  }
}

// ---------- "Make fillable?" card ----------

function setupFieldsAsk(): void {
  const card = $('ask-fields');
  const render = () => {
    const doc = store.doc;
    const n = doc ? fieldCount(doc) : 0;
    const show = !!doc && doc.fieldsOn === null && n >= 2 && !store.fullpage;
    card.hidden = !show;
    if (!show) return;
    const pages = new Set([...doc!.fields.entries()].filter(([, l]) => l.length).map(([k]) => k)).size;
    card.innerHTML = `
      <span class="ask-ico">${icon('wand')}</span>
      <div class="ask-text">
        <strong>Fill in this form?</strong>
        <p>Nib-E found <b>${n}</b> place${n === 1 ? '' : 's'} to fill in${pages > 1 ? ` on ${pages} pages` : ''}${doc!.detecting ? ' so far' : ''}. Turn them into boxes you can type in?</p>
        <div class="ask-actions"><button class="btn btn-quiet sm" type="button" data-a="no">Not now</button><button class="btn btn-primary sm" type="button" data-a="yes">${icon('wand')}Make fillable</button></div>
      </div>
      <button class="icon-btn sm ask-x" type="button" data-a="no" aria-label="Not now">${icon('close')}</button>`;
  };
  card.addEventListener('click', (e) => {
    const a = ((e.target as HTMLElement).closest('[data-a]') as HTMLElement | null)?.dataset.a;
    if (!a || !store.doc) return;
    if (a === 'yes') {
      store.setFieldsOn(true);
      store.setPanel('fill');
      if (!['hand', 'select', 'text', 'mark'].includes(store.tool)) store.setTool('hand');
      toast('Click a box to type. Tab moves to the next one.', 'ok', 5000);
    } else {
      store.setFieldsOn(false);
      toast('You can turn them on any time in Toolbox → Fill in & sign.', 'info', 5000);
    }
    render();
  });
  store.on((why) => {
    if (why === 'fields' || why === 'doc' || why === 'mode') render();
  });
  render();
}

// ---------- redaction and saving ----------

async function applyRedactions(): Promise<void> {
  const n = pendingRedactions();
  if (!n) {
    toast('Mark something first: drag over it with the redact tool.');
    store.setTool('redact');
    return;
  }
  const res = await ask({
    title: `Apply ${n} redaction${n === 1 ? '' : 's'}?`,
    body: `<p>Everything under the marks is removed from the file for good. Your ink, text and stamps are flattened into the pages.${store.prefs.sanitize ? ' Hidden information (metadata, attachments, scripts, bookmarks) is removed and form fields are flattened.' : ''}${store.prefs.rasterize ? ' Redacted pages become images.' : ''}</p><p>The redacted version replaces the open document. Save it afterwards.</p>`,
    actions: [
      { label: 'Cancel', value: false, kind: 'quiet' },
      { label: 'Apply redactions', value: true, kind: 'danger' },
    ],
  });
  if (!res?.value) return;
  const result = await withBusy('Redacting…', () => redactNow());
  if (!result) return;
  store.setTool('select');
  store.setPanel('redact');
  panel.showResult(`Redacted ${result.pages} page${result.pages === 1 ? '' : 's'}: ${result.removedChars} characters removed, photos under the boxes erased. Check passed: no text left under any box. Save to keep it.`);
  toast('Redaction applied. Save to keep the redacted file.', 'ok', 6000);
}

/** Asks about redaction marks that are not applied yet. Returns false to stop. */
async function redactionsHandled(): Promise<boolean> {
  const n = pendingRedactions();
  if (!n) return true;
  const res = await ask({
    title: 'Redaction marks are not applied yet',
    body: `<p>${n} area${n === 1 ? ' is' : 's are'} marked for redaction. Saving now would keep the content under ${n === 1 ? 'it' : 'them'}.</p>`,
    actions: [
      { label: 'Cancel', value: 'cancel', kind: 'quiet' },
      { label: 'Save without them', value: 'skip' },
      { label: 'Apply, then save', value: 'apply', kind: 'danger' },
    ],
  });
  if (!res || res.value === 'cancel') return false;
  if (res.value === 'apply') {
    await applyRedactions();
    if (pendingRedactions()) return false;
  }
  return true;
}

/** Save (Ctrl+S). Returns true when the work is safe (written, or kept for a study book). */
async function save(): Promise<boolean> {
  const doc = store.doc;
  if (!doc) return false;
  if (!(await redactionsHandled())) return false;
  const r = await withBusy('Saving…', () => saveDoc(store.doc!));
  return r === 'saved' || r === 'kept';
}

/** Save as (Ctrl+Shift+S). */
async function saveAsNew(): Promise<boolean> {
  if (!store.doc) return false;
  if (!(await redactionsHandled())) return false;
  const r = await withBusy('Saving…', () => saveDocAs(store.doc!));
  return r === 'saved';
}

async function print(): Promise<void> {
  const doc = store.doc;
  if (!doc) return;
  const o = await askPrint(doc);
  if (!o) return;
  await withBusy('Preparing…', () => printDoc(doc, o));
}

async function menuAction(a: MenuAction): Promise<void> {
  const doc = store.doc;
  if (!doc) return;
  const done = (r: unknown, msg: string) => {
    if (r === 'saved') toast(msg, 'ok');
  };
  switch (a) {
    case 'save':
      await save();
      break;
    case 'saveas':
      await saveAsNew();
      break;
    case 'with-notes':
      done(await withBusy('Exporting…', () => exportWithNotes(doc)), 'Exported with your notes at the end.');
      break;
    case 'flat':
      done(await withBusy('Exporting…', () => exportFlattened(doc)), 'Exported a flattened copy.');
      break;
    case 'notes-only':
      done(await withBusy('Exporting…', () => exportNotesOnly()), 'Exported your notes.');
      break;
    case 'images':
      store.setPanel('export');
      break;
    case 'text':
      done(await withBusy('Exporting…', () => exportText(doc)), 'Exported the text.');
      break;
    case 'backup':
      done(await withBusy('Exporting…', () => exportBackup(doc)), 'Notes backup saved. Restore it from the start screen on another device.');
      break;
    case 'print':
      await print();
      break;
    case 'restore':
      await withBusy('Restoring…', () =>
        restoreBackup(doc, async (name, bytes, ref) => {
          const i = store.tabs.indexOf(doc);
          closeDoc(doc);
          await openBytes(name, bytes, { ref });
          if (i >= 0 && store.doc) {
            store.tabs.splice(store.tabs.indexOf(store.doc), 1);
            store.tabs.splice(i, 0, store.doc);
            store.emit('tabs');
          }
          toast('The earlier version is back.', 'ok');
        }),
      );
      break;
  }
}

function setupPassword(): void {
  const dlg = $<HTMLDialogElement>('pw-dialog');
  const input = $<HTMLInputElement>('pw-input');
  setPasswordAsker(
    (name, wrong) =>
      new Promise((resolve) => {
        $('pw-sub').textContent = `${name} is protected. Enter its password to open it.`;
        $('pw-error').hidden = !wrong;
        input.value = '';
        let settled = false;
        const done = (v: string | null) => {
          if (settled) return;
          settled = true;
          dlg.onclose = null;
          if (dlg.open) dlg.close();
          resolve(v);
        };
        $('pw-form').onsubmit = (e) => {
          e.preventDefault();
          done(input.value);
        };
        $('pw-cancel').onclick = () => done(null);
        dlg.onclose = () => done(null);
        dlg.showModal();
        input.focus();
      }),
  );
}

function setupDrop(): void {
  const zone = $('dropzone');
  let depth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || document.querySelector('dialog[open]')) return;
    depth += 1;
    zone.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    // Handles must be requested while the drop event runs (Chrome / Edge can then save back).
    const refsP = droppedRefs(e.dataTransfer?.items);
    const all = [...(e.dataTransfer?.files ?? [])];
    const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    const files = all.filter(isPdf);
    if (!files.length) {
      toast('Only PDF files can be opened. To add pictures, use Toolbox → Merge files.', 'error');
      return;
    }
    // Each file opens in its own tab; with Shift held, pages go into this file.
    if (e.shiftKey && store.doc) void merge(files);
    else
      void refsP.then((refs) => {
        const pdfRefs = all.map((f, i) => (isPdf(f) ? (refs[i] ?? null) : undefined)).filter((r) => r !== undefined) as (FileRef | null)[];
        return openMany(files, pdfRefs);
      });
  });
}

function setupKeys(): void {
  const toolKeys: Record<string, Tool> = { v: 'select', h: 'hand', t: 'text', p: 'pen', m: 'highlighter', e: 'eraser', s: 'sign', n: 'note', r: 'shape', u: 'markup' };
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, dialog, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      store.redo();
    } else if (mod && k === 's') {
      e.preventDefault();
      if (e.shiftKey) void saveAsNew();
      else void save();
    } else if (mod && k === 'p') {
      e.preventDefault();
      void print();
    } else if (mod && k === 'o') {
      e.preventDefault();
      void openDialog();
    } else if (mod && (k === '=' || k === '+')) {
      e.preventDefault();
      activeViewer().zoomBy(1.2);
    } else if (mod && k === '-') {
      e.preventDefault();
      activeViewer().zoomBy(1 / 1.2);
    } else if (mod && k === '0') {
      e.preventDefault();
      viewer.fit('width');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.sel) {
      e.preventDefault();
      activeViewer().deleteSelection();
    } else if (e.key === 'Escape') {
      if (store.sel) store.select(null);
      else if (store.fullpage) store.setFullpage(false);
    } else if (!mod && !e.altKey && k === 'f') {
      if (store.doc) store.setFullpage(!store.fullpage);
    } else if (!mod && !e.altKey && (k === '?' || e.key === 'F1')) {
      e.preventDefault();
      openHelp();
    } else if (!mod && !e.altKey && toolKeys[k]) {
      store.setTool(toolKeys[k]);
    } else if (!mod && (e.key === 'PageDown' || e.key === 'PageUp' || (store.fullpage && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')))) {
      e.preventDefault();
      const dir = e.key === 'PageDown' || e.key === 'ArrowRight' ? 1 : -1;
      viewer.scrollToPage(Math.max(0, Math.min(store.pages.length - 1, store.current + dir)));
    }
  });
  // Closing or reloading the browser tab with unsaved files: the browser asks first.
  window.addEventListener('beforeunload', (e) => {
    void flushAll();
    if (unsavedTabs().length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ---------- study library, recovery, desktop app ----------

function setupStorage(): void {
  setOpenHook(afterOpen);
  setRestoreNotice((state, how, plan, dropped) => {
    const marks = plan.pages.reduce((n, p) => n + p.items.length, 0);
    const notes = plan.notes.filter((p) => p.items.length).length;
    const parts = [marks ? `${marks} mark${marks === 1 ? '' : 's'}` : '', notes ? `${notes} note page${notes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    toast(`Welcome back to “${state.name.replace(/\.pdf$/i, '')}”${parts ? `: ${parts} restored${how === 'file' ? ' from the file' : ''}` : ''}. Page ${state.current + 1}.`, 'ok', 6500);
    if (dropped) toast(`${dropped} page${dropped === 1 ? '' : 's'} added from other files could not be restored.`, 'info', 6500);
    if (state === store.doc && state.current > 0) setTimeout(() => viewer.scrollToPage(state.current), 120);
  });
  setDownloadNotice(() => {
    let seen = false;
    try {
      seen = localStorage.getItem('nib.dltip') === '1';
      localStorage.setItem('nib.dltip', '1');
    } catch {
      /* storage unavailable */
    }
    if (seen) toast('Saved to your Downloads folder.', 'ok');
    else
      toast(
        'Saved to your Downloads folder. This browser has no Save window for web pages. To choose a folder each time, turn on “Always ask where to save files” in the browser settings, or use Chrome, Edge or the Nib-E desktop app.',
        'info',
        12000,
      );
  });
  startAutosave();
}

/** Offers work that was not saved when Nib-E closed (crash, closed tab). */
async function offerRecovery(): Promise<void> {
  const list = await pendingRecovery();
  if (!list.length) return;
  const names = list
    .slice(0, 6)
    .map((r) => `<li>${esc(r.name)} <small>(${new Date(r.updated).toLocaleString()})</small></li>`)
    .join('');
  const res = await ask({
    title: list.length === 1 ? 'Unsaved changes found' : `Unsaved changes in ${list.length} files`,
    body: `<p>Nib-E closed before these were saved. Restore them?</p><ul class="plain-list">${names}</ul>`,
    actions: [
      { label: 'Discard', value: 'discard', kind: 'quiet' },
      { label: 'Later', value: 'later' },
      { label: 'Restore', value: 'restore', kind: 'primary' },
    ],
  });
  if (!res || res.value === 'later') return;
  if (res.value === 'discard') {
    await discardRecovery(list);
    return;
  }
  const n = await withBusy('Restoring…', () => restoreRecovery(list));
  if (n) toast(`Restored ${n} file${n === 1 ? '' : 's'}. Save to keep the changes.`, 'ok', 6000);
}

async function closeApp(): Promise<void> {
  await flushAll();
  const un = unsavedTabs();
  if (un.length) {
    const res = await ask({
      title: un.length === 1 ? `Save changes to “${un[0].name}”?` : `${un.length} files have unsaved changes`,
      body: `<p>If you close Nib-E now, these changes are lost:</p><ul class="plain-list">${un.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>`,
      actions: [
        { label: 'Cancel', value: 'cancel', kind: 'quiet' },
        { label: 'Close without saving', value: 'close', kind: 'danger' },
      ],
    });
    if (!res || res.value !== 'close') return;
    for (const t of un) await dropRecovery(t);
  }
  await invoke('close_app');
}

async function setupDesktop(): Promise<void> {
  if (!isDesktop()) return;
  app.classList.add('desktop');
  listen<string[]>('nib://open-paths', (paths) => void openPaths(paths));
  // Dropped files arrive as nib://open-paths (the app first allows Nib-E to read them).
  listen('tauri://drag-drop', () => ($('dropzone').hidden = true));
  listen('tauri://drag-enter', () => ($('dropzone').hidden = false));
  listen('tauri://drag-leave', () => ($('dropzone').hidden = true));
  listen('nib://close-requested', () => void closeApp());
  try {
    const start = await invoke<string[]>('startup_files');
    if (start.length) await openPaths(start);
  } catch (e) {
    console.warn(e);
  }
}

/** Withholds keyboard deletion while typing; exposed for the context bar. */
function deleteSelected(): void {
  activeViewer().deleteSelection();
}

/** Withstands a WebAssembly start that never settles. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('PDF engine start timed out')), ms))]);
}

async function boot(): Promise<void> {
  // Tell the start-up watchdog in index.html that the app code is running.
  (window as unknown as { __nibStarted: boolean }).__nibStarted = true;
  document.getElementById('nib-not-started')?.remove();
  setupChrome();
  setupMeta();
  setupTabs();
  setupPassword();
  setupDrop();
  prepareSaving();
  viewer = new Viewer($('viewer'), $('pages'), 'pages');
  notebook = new Viewer($('nb-viewer'), $('nb-pages'), 'notes');
  new Sidebar($('sidebar'), viewer, withBusy);
  new Dock($('dock'), {
    zoomBy: (f) => activeViewer().zoomBy(f),
    fit: (m) => {
      viewer.fit(m);
      if (store.study) notebook.fit('width');
    },
    applyRedactions: () => void applyRedactions(),
  });
  new ContextBar($('ctxbar'), deleteSelected);
  panel = new ToolPanel($('panel'), {
    busy: withBusy,
    scrollToPage: (i) => viewer.scrollToPage(i),
    applyRedactions: () => void applyRedactions(),
  });
  setupLayout();
  setupNotebookBar();
  setupKeys();
  setupFieldsAsk();
  setupStorage();
  new LibraryView($('library'), () => void openDialog(), withBusy);

  try {
    await withTimeout(startPdfium(), 30_000);
  } catch (e) {
    console.error(e);
    $('boot-text').textContent =
      'The PDF engine could not start here. This browser view may block WebAssembly. Download Nib-E.html and double-click it to open it in Chrome, Edge or Firefox.';
    app.classList.add('boot-failed');
    return;
  }
  $('boot').hidden = true;
  app.classList.add('ready');
  app.classList.toggle('no-save-window', !hasSaveWindow());
  if (!helpSeen()) openHelp();
  else void offerRecovery();
  await setupDesktop();

  // Test hook, used by the automated checks in test/.
  (window as unknown as { __nib: unknown }).__nib = { store, viewer, notebook, exportPdf, openBytes, mergeFile, mergeBytes, fieldCount, closeDoc, closeTab, openHelp, myStamps, useStamp, save, saveAsNew, menuAction, flushAll, offerRecovery, setRecoveryIdle, listBooks, landingUrl, redactNow, checkImages };
}

void boot();
