// The right-hand panel: "Toolbox" home and one view per tool.
import {
  compressAndSave,
  exportImages,
  fieldCount,
  imagesAsPdf,
  loadImage,
  markSearch,
  markWholePage,
  mergeBytes,
  mergeFile,
  openBytes,
  pendingRedactions,
  protectAndSave,
  saveNotes,
  saveSelection,
} from '../doc';
import { DEFAULT_HF, DEFAULT_WM, shownSize, uid, type HeaderFooter, type Template, type Watermark } from '../model';
import type { Finding } from '../pdf/check';
import { store, type PanelView, type Tool } from '../store';
import { icon } from './icons';
import { openSignaturePad } from './signature';
import { toast } from './toast';
import { STAMPS, TOOL_INFO } from './tools';
import { openHelp } from './help';
import { SPELL_LANGS } from './spelling';
import { addPngStamp, deleteStamp, myStamps, openStampMaker, useStamp } from './stamps';
import { VERSION } from '../version';
import { buildLabel, EDITION, updateNote } from '../config';
import { isDesktop, invoke } from '../platform/env';
import { idbClear } from '../platform/idb';
import { setKeep } from '../library';
import { exportBackup } from '../saving';
import { FEEL_LABEL } from './dock';

export interface PanelHost {
  busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>;
  scrollToPage(i: number): void;
  applyRedactions(): void;
}

interface ToolEntry {
  view: PanelView;
  label: string;
  icon: string;
  desc: string;
}

interface ToolGroup {
  title: string;
  tools: ToolEntry[];
}

// Names are deliberately Nib-E's own wording (noun forms), not other apps' menu labels.
const GROUPS: ToolGroup[] = [
  {
    title: 'Write',
    tools: [
      { view: 'edit', label: 'Content editor', icon: 'edit', desc: 'Text, images, header and footer, watermark, links' },
      { view: 'fill', label: 'Form filling & signature', icon: 'fillSign', desc: 'Type into form boxes, tick boxes, sign' },
      { view: 'form', label: 'Form builder', icon: 'form', desc: 'Turn found boxes into real form fields' },
      { view: 'comment', label: 'Annotations', icon: 'comment', desc: 'Notes, text highlights, shapes, drawing' },
      { view: 'stamp', label: 'Stamp library', icon: 'stamp', desc: 'Approved, Draft, Confidential, your own' },
    ],
  },
  {
    title: 'Pages',
    tools: [
      { view: 'organize', label: 'Page manager', icon: 'organize', desc: 'Insert, rotate, move, delete, extract' },
      { view: 'combine', label: 'File merger', icon: 'combine', desc: 'Add PDFs or images as pages' },
      { view: 'compress', label: 'Size reducer', icon: 'compress', desc: 'Shrink large photos' },
    ],
  },
  {
    title: 'Protect',
    tools: [
      { view: 'redact', label: 'PDF redaction', icon: 'redact', desc: 'Remove text and images for good' },
      { view: 'protect', label: 'Password lock', icon: 'protect', desc: 'Password with AES-256' },
      { view: 'check', label: 'Safety report', icon: 'shield', desc: 'What this file contains (safe mode)' },
    ],
  },
  {
    title: 'Convert',
    tools: [
      { view: 'export', label: 'Image export', icon: 'exportImg', desc: 'Pages as PNG or JPEG' },
      { view: 'create', label: 'Image to PDF', icon: 'createPdf', desc: 'Photos and scans into one PDF' },
    ],
  },
  {
    title: 'Study',
    tools: [{ view: 'study', label: 'Study mode', icon: 'study', desc: 'PDF beside a notebook' }],
  },
];

const SETTINGS_ENTRY: ToolEntry = { view: 'settings', label: 'Settings', icon: 'settings', desc: 'Appearance, pen feel, saving, saved data' };

const ALL_TOOLS: ToolEntry[] = [...GROUPS.flatMap((g) => g.tools), SETTINGS_ENTRY];

/** Panel title for a tool view (used by other modules for consistent wording). */
export function toolLabel(v: PanelView): string {
  return ALL_TOOLS.find((t) => t.view === v)?.label ?? '';
}

export const UI_SIZES = [1, 1.25, 1.5, 1.75, 2];

const LATER: { label: string; icon: string }[] = [
  { label: 'Text recognition', icon: 'ocr' },
  { label: 'Office conversion', icon: 'word' },
  { label: 'Version diff', icon: 'compare' },
  { label: 'Measuring tool', icon: 'measure' },
  { label: 'Certificate signing', icon: 'certificate' },
];

const TITLES: Partial<Record<PanelView, string>> = {
  hf: 'Header and footer',
  wm: 'Watermark',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function toolBtn(tool: Tool, label?: string, sub?: string): string {
  const info = TOOL_INFO[tool];
  return `<button class="row-btn" type="button" data-tool="${tool}" aria-pressed="${store.tool === tool}">${icon(info.icon)}<span class="row-text"><span>${label ?? info.label}</span>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
}

function actBtn(act: string, ic: string, label: string, sub?: string, extra = ''): string {
  return `<button class="row-btn" type="button" data-act="${act}" ${extra}>${icon(ic)}<span class="row-text"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
}

function section(title: string, body: string): string {
  return `<section class="pv-section"><h3>${title}</h3>${body}</section>`;
}

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export class ToolPanel {
  private body: HTMLElement;
  private title: HTMLElement;
  private back: HTMLButtonElement;
  private lastResult = '';

  constructor(root: HTMLElement, private host: PanelHost) {
    this.body = root.querySelector('#panel-body')!;
    this.title = root.querySelector('#panel-title')!;
    this.back = root.querySelector('#panel-back')!;
    this.back.innerHTML = icon('back');
    this.back.addEventListener('click', () => store.setPanel(this.parentOf(store.panel)));
    (root.querySelector('#panel-close') as HTMLButtonElement).innerHTML = icon('close');
    root.querySelector('#panel-close')!.addEventListener('click', () => store.setPrefs({ rightOpen: false }));
    this.body.addEventListener('click', (e) => void this.onClick(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    this.body.addEventListener('submit', (e) => e.preventDefault());
    store.on((why) => {
      if (why === 'panel') {
        this.lastResult = '';
        this.render();
      } else if (why === 'doc' || why === 'fields' || why === 'tool' || why === 'mode' || why === 'notes' || why === 'decor') this.render();
      else if ((why === 'items' || why === 'pages' || why === 'prefs' || why === 'library') && ['redact', 'fill', 'form', 'study', 'stamp', 'organize', 'settings'].includes(store.panel)) this.render();
    });
    this.render();
  }

  private parentOf(v: PanelView): PanelView {
    return v === 'hf' || v === 'wm' ? 'edit' : 'home';
  }

  render(): void {
    const v = store.panel;
    const entry = ALL_TOOLS.find((t) => t.view === v);
    this.title.textContent = v === 'home' ? 'Toolbox' : TITLES[v] ?? entry?.label ?? '';
    this.back.hidden = v === 'home';
    const active = document.activeElement;
    const keepFocus = active instanceof HTMLInputElement && this.body.contains(active) ? active.id : '';
    this.body.innerHTML = this.view(v);
    if (keepFocus) (this.body.querySelector(`#${keepFocus}`) as HTMLInputElement | null)?.focus();
  }

  private view(v: PanelView): string {
    const doc = store.doc;
    if (!doc && v !== 'home') return '<p class="muted">Open a PDF first.</p>';
    switch (v) {
      case 'home': {
        const row = (t: ToolEntry) => `<li><button type="button" class="tool-row" data-view="${t.view}"><span class="tool-ico">${icon(t.icon)}</span><span class="row-text"><span>${t.label}</span><small>${t.desc}</small></span></button></li>`;
        return `${GROUPS.map((g) => `<section class="tool-group"><h3 class="tool-group-title">${g.title}</h3><ul class="tool-list">${g.tools.map(row).join('')}</ul></section>`).join('')}
          <section class="tool-group"><h3 class="tool-group-title">App</h3><ul class="tool-list">${row(SETTINGS_ENTRY)}</ul>
          ${actBtn('help', 'help', 'Help and tour', 'How Nib-E works, privacy, study mode')}</section>
          <section class="tool-group later"><h3 class="tool-group-title">Planned</h3><ul class="tool-list">${LATER.map((t) => `<li><span class="tool-row" aria-disabled="true"><span class="tool-ico">${icon(t.icon)}</span><span class="row-text"><span>${t.label}</span></span><span class="tag">Later</span></span></li>`).join('')}</ul></section>`;
      }
      case 'edit':
        return (
          section(
            'Modify page',
            `<div class="icon-row">
              <button class="icon-btn" type="button" data-act="rotL" title="Rotate left">${icon('rotL')}</button>
              <button class="icon-btn" type="button" data-act="rotR" title="Rotate right">${icon('rotR')}</button>
              <button class="icon-btn" type="button" data-act="insert-blank" title="Insert a blank page">${icon('pageAdd')}</button>
              <button class="icon-btn danger" type="button" data-act="delete" title="Delete page">${icon('trash')}</button>
              <button class="icon-btn" type="button" data-act="extract" title="Save page as a new PDF">${icon('extract')}</button>
            </div>${actBtn('view:organize', 'organize', 'Page manager')}`,
          ) +
          section(
            'Add content',
            toolBtn('text', 'Text', 'Click anywhere to type') +
              actBtn('image', 'image', 'Image', store.pendingImage ? 'Click on a page to place it' : 'PNG, JPEG, WebP…') +
              actBtn('view:hf', 'headerFooter', 'Header and footer', store.plan.hf ? 'On' : undefined) +
              actBtn('view:wm', 'watermark', 'Watermark', store.plan.wm ? 'On' : undefined) +
              toolBtn('link', 'Link', 'Drag a box, enter a web address'),
          ) +
          section('Other options', actBtn('view:combine', 'combine', 'File merger') + actBtn('view:redact', 'redact', 'PDF redaction') + actBtn('view:form', 'form', 'Form builder')) +
          `<p class="muted small">Editing the PDF's existing text is not supported. Cover it with a white box and type on top if needed.</p>`
        );
      case 'hf':
        return this.hfView(store.plan.hf);
      case 'wm':
        return this.wmView(store.plan.wm);
      case 'fill': {
        const n = fieldCount();
        const on = !!doc!.fieldsOn;
        const answered = store.pages.reduce((a, p) => a + p.items.filter((it) => (it.type === 'text' || it.type === 'mark') && it.field).length, 0);
        let status: string;
        if (n && on) status = `<div class="callout ok">${icon('wand')}<p><strong>${n} boxes</strong>${answered ? ` · ${answered} filled` : ''}. Click a box to type; text uses the label's font and size. <kbd>Tab</kbd> jumps to the next box.</p></div>`;
        else if (n) status = `<div class="callout">${icon('wand')}<p><strong>${n} fill-in place${n === 1 ? '' : 's'} found</strong>${doc!.detecting ? ' so far' : ''}. Turn them into boxes you can type in?</p></div><button class="btn btn-primary wide" type="button" data-act="fields-on">${icon('wand')}Make fillable</button>`;
        else if (doc!.detecting) status = `<div class="callout">${icon('search')}<p>Looking for form boxes…</p></div>`;
        else if (doc!.hasForm) status = '';
        else status = `<div class="callout">${icon('info')}<p>No form boxes found. Use Add text anywhere on the page.</p></div>`;
        return (
          (doc!.hasForm ? `<div class="callout">${icon('info')}<p>This PDF has real form fields. Use the hand tool and click a field to fill it.</p></div>` : '') +
          status +
          (n ? `<label class="switch"><input type="checkbox" id="pf-show" ${on ? 'checked' : ''}/><span>Show fill-in boxes</span></label>` : '') +
          section('Fill', toolBtn('text', 'Add text') + toolBtn('mark', 'Checkmark', 'Tick, cross or dot') + toolBtn('hand', 'Fill boxes', 'Click a box to type into it')) +
          section('Sign', toolBtn('sign', 'Add signature', 'Tap the page to place it') + actBtn('redraw', 'sign', 'Draw a new signature')) +
          (answered ? `<button class="btn btn-quiet wide" type="button" data-act="clear-answers">Clear all answers</button>` : '')
        );
      }
      case 'form': {
        const n = fieldCount();
        const manual = store.pages.reduce((a, p) => a + p.items.filter((it) => it.type === 'field').length, 0);
        const rows: string[] = [];
        store.pages.forEach((p, i) => {
          const f = store.fieldsFor(p);
          if (!f.length) return;
          const counts = { text: f.filter((x) => x.kind === 'text').length, check: f.filter((x) => x.kind === 'check').length, radio: f.filter((x) => x.kind === 'radio').length };
          rows.push(`<li><button type="button" class="link-row" data-page="${i}">Page ${i + 1}</button><span>${[counts.text && `${counts.text} text`, counts.check && `${counts.check} checkbox`, counts.radio && `${counts.radio} round`].filter(Boolean).join(' · ')}</span></li>`);
        });
        return (
          `<label class="switch"><input type="checkbox" id="pf-fillable" ${store.prefs.fillable ? 'checked' : ''}/><span>Save as a fillable form</span></label>` +
          `<p class="muted small">When on, Save turns ${n + manual} box${n + manual === 1 ? '' : 'es'} into real form fields that anyone can fill in any PDF reader. Answers you typed become the field values. Round buttons on one row become one choice.</p>` +
          (rows.length ? section('Found boxes', `<ul class="mini-list">${rows.join('')}</ul>`) : '') +
          section('Add fields by hand', toolBtn('field', 'Draw a field', 'Text field or checkbox')) +
          (doc!.hasForm ? `<p class="muted small">This file already has form fields. They are kept as they are.</p>` : '')
        );
      }
      case 'comment':
        return (
          section('Comment', toolBtn('note', 'Sticky note') + toolBtn('markup', 'Highlight text', 'Highlight, underline, strikethrough') + toolBtn('text', 'Add text')) +
          section('Draw', toolBtn('pen') + toolBtn('highlighter', 'Highlighter pen') + toolBtn('shape', 'Shapes', 'Rectangle, ellipse, line, arrow') + toolBtn('eraser')) +
          `<p class="muted small">Notes, highlights and shapes are saved as standard PDF comments, so other readers can show, edit or delete them.</p>`
        );
      case 'stamp': {
        const cur = store.prefs.stamp;
        return (
          section(
            'Choose a stamp',
            `<div class="stamp-grid">${STAMPS.map((s) => `<button type="button" class="stamp-pick" data-stamp="${s.label}" data-color="${s.color}" style="--c:${s.color}" aria-pressed="${s.label === cur.label}">${s.label}</button>`).join('')}</div>`,
          ) +
          section(
            'Custom',
            `<div class="inline-form"><input class="text-input" id="pf-stamp-text" maxlength="24" placeholder="Your text" value="${STAMPS.some((s) => s.label === cur.label) ? '' : esc(cur.label)}"/><button class="btn" type="button" data-act="stamp-custom">Use</button></div>`,
          ) +
          `<label class="switch"><input type="checkbox" id="pf-stamp-date" ${store.prefs.stampDate ? 'checked' : ''}/><span>Add today's date</span></label>` +
          `<button class="btn btn-primary wide" type="button" data-tool="stamp">${icon('stamp')}Place stamp</button>` +
          `<p class="muted small">Click the page to place it. Use the select tool to move or resize it.</p>` +
          section('My stamps', this.myStampsHtml())
        );
      }
      case 'redact': {
        const n = pendingRedactions();
        return (
          `<div class="callout danger">${icon('redact')}<p>Redaction <strong>removes</strong> content from the file: text under a box is deleted and photo pixels are erased. It can't be undone after you apply it.</p></div>` +
          section(
            '1 · Mark',
            toolBtn('redact', 'Mark an area', 'Drag over text, images or anything else') +
              `<form class="inline-form" id="pf-find-form"><input class="text-input" id="pf-find" placeholder="Find text, e.g. a name or number" autocomplete="off"/><button class="btn" type="submit" data-act="find-mark">${icon('search')}Mark all</button></form>` +
              actBtn('mark-page', 'blank', 'Mark the current page', 'Blacks out the whole page'),
          ) +
          section(
            '2 · Options',
            `<label class="check-row"><input type="checkbox" id="pf-sanitize" ${store.prefs.sanitize ? 'checked' : ''}/><span><strong>Remove hidden information</strong><small>Metadata, attachments, scripts, bookmarks. Form fields are flattened.</small></span></label>
             <label class="check-row"><input type="checkbox" id="pf-raster" ${store.prefs.rasterize ? 'checked' : ''}/><span><strong>Turn redacted pages into images</strong><small>Strongest: also removes vector drawings partly under a box. Text on those pages can't be selected afterwards.</small></span></label>
             ${store.prefs.rasterize ? `<p class="note-warn">${icon('info')}<span><strong>Please check:</strong> a tester got a damaged page picture with this option. Nib-E now checks every page picture and stops if one is damaged, but please open the saved file once to check it before you share it.</span></p>` : ''}`,
          ) +
          section(
            '3 · Apply',
            `<button class="btn btn-danger wide" type="button" data-act="redact-apply" ${n ? '' : 'disabled'}>Apply ${n || ''} redaction${n === 1 ? '' : 's'}</button>
             ${n ? `<button class="btn btn-quiet wide" type="button" data-act="redact-clear">Remove all marks</button>` : ''}
             <p class="muted small">Your ink, text and stamps are flattened into the pages at the same time. Afterwards Nib-E checks that no text is left under any box.</p>`,
          ) +
          (this.lastResult ? `<div class="callout ok">${icon('check')}<p>${this.lastResult}</p></div>` : '')
        );
      }
      case 'organize':
        return (
          section(
            'Insert',
            `<div class="seg">${(['blank', 'lined', 'grid'] as Template[]).map((t) => `<button type="button" class="btn" data-act="insert-${t}">${icon(t === 'blank' ? 'blank' : t === 'lined' ? 'lines' : 'grid')}${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`,
          ) +
          section(
            store.selected.size ? `${store.selected.size} selected pages` : `Page ${store.current + 1}`,
            `<div class="icon-row">
              <button class="icon-btn" type="button" data-act="rotL" title="Rotate left">${icon('rotL')}</button>
              <button class="icon-btn" type="button" data-act="rotR" title="Rotate right">${icon('rotR')}</button>
              <button class="icon-btn" type="button" data-act="up" title="Move up">${icon('up')}</button>
              <button class="icon-btn" type="button" data-act="down" title="Move down">${icon('down')}</button>
              <button class="icon-btn" type="button" data-act="extract" title="Save as a new PDF">${icon('extract')}</button>
              <button class="icon-btn danger" type="button" data-act="delete" title="Delete">${icon('trash')}</button>
            </div>
            <button class="btn btn-quiet" type="button" data-act="select-all">Select all pages</button>`,
          ) +
          `<p class="muted small">Tip: drag thumbnails in the left panel to reorder. Ctrl-click or Shift-click selects several pages.</p>`
        );
      case 'combine':
        return (
          section('Add to the end', actBtn('merge', 'addfile', 'Add PDF files', 'Pages are appended in the order you pick them') + actBtn('add-images', 'image', 'Add images as pages', 'One A4 page per image')) +
          `<p class="muted small">${store.pages.length} pages from ${doc!.sources.size} file${doc!.sources.size === 1 ? '' : 's'}. Save writes one combined PDF.</p>`
        );
      case 'compress':
        return (
          section(
            'Quality',
            `<div class="radio-list">
              ${[
                ['high', 'High', '150 dpi photos · best for printing'],
                ['medium', 'Medium', '110 dpi · good on screen'],
                ['small', 'Smallest', '72 dpi · email and upload limits'],
              ]
                .map(([v, l, d], i) => `<label class="check-row"><input type="radio" name="pf-q" value="${v}" ${i === 1 ? 'checked' : ''}/><span><strong>${l}</strong><small>${d}</small></span></label>`)
                .join('')}
            </div>`,
          ) +
          `<button class="btn btn-primary wide" type="button" data-act="compress">${icon('compress')}Compress and save</button>` +
          `<p class="muted small">Large photos are scaled down and saved as JPEG. Text, drawings and transparent images are not changed. If the file can't get smaller, it is saved unchanged.</p>` +
          (this.lastResult ? `<div class="callout ok">${icon('check')}<p>${this.lastResult}</p></div>` : '')
        );
      case 'protect':
        return (
          `<form class="stack" id="pf-protect" autocomplete="off">
            <label class="field-label">Password to open<input class="text-input" type="password" id="pf-pw1" autocomplete="new-password"/></label>
            <label class="field-label">Repeat password<input class="text-input" type="password" id="pf-pw2" autocomplete="new-password"/></label>
            ${section(
              'Allow',
              `<label class="check-row"><input type="checkbox" id="pf-print" checked/><span>Printing</span></label>
               <label class="check-row"><input type="checkbox" id="pf-copy" checked/><span>Copying text and images</span></label>
               <label class="check-row"><input type="checkbox" id="pf-edit" checked/><span>Editing, comments and form filling</span></label>`,
            )}
            <button class="btn btn-primary wide" type="submit" data-act="protect">${icon('lock')}Save protected copy</button>
          </form>` +
          `<p class="muted small">Uses AES-256 encryption. There is no way to recover a forgotten password. Restrictions are honoured by most readers but are not a strong protection on their own.</p>`
        );
      case 'export':
        return (
          section(
            'Format',
            `<div class="seg"><label class="seg-opt"><input type="radio" name="pf-fmt" value="image/png" checked/><span>PNG</span></label><label class="seg-opt"><input type="radio" name="pf-fmt" value="image/jpeg"/><span>JPEG</span></label></div>`,
          ) +
          section(
            'Resolution',
            `<div class="seg">${[72, 150, 300].map((d) => `<label class="seg-opt"><input type="radio" name="pf-dpi" value="${d}" ${d === 150 ? 'checked' : ''}/><span>${d} dpi</span></label>`).join('')}</div>`,
          ) +
          section(
            'Pages',
            `<div class="seg"><label class="seg-opt"><input type="radio" name="pf-pages" value="all" checked/><span>All ${store.pages.length}</span></label><label class="seg-opt"><input type="radio" name="pf-pages" value="target"/><span>${store.selected.size ? `${store.selected.size} selected` : `Page ${store.current + 1}`}</span></label></div>`,
          ) +
          `<button class="btn btn-primary wide" type="button" data-act="export">${icon('exportImg')}Export</button><p class="muted small">Several pages are saved together as a ZIP file.</p>`
        );
      case 'create':
        return (
          section(
            'Page size',
            `<div class="seg"><label class="seg-opt"><input type="radio" name="pf-size" value="a4" checked/><span>A4, fitted</span></label><label class="seg-opt"><input type="radio" name="pf-size" value="fit"/><span>Same as image</span></label></div>`,
          ) +
          actBtn('create-new', 'createPdf', 'Choose images → new PDF', 'Opens as a new document') +
          actBtn('add-images', 'addfile', 'Choose images → add to this PDF', 'Appended at the end')
        );
      case 'study': {
        const doc = store.doc;
        const notes = store.notes.length;
        const keep = doc?.bookId ? doc.keep : store.prefs.studyKeep;
        const opt = (v: 'device' | 'file', title: string, text: string) =>
          `<label class="check-row"><input type="radio" name="pf-keep" value="${v}" ${keep === v ? 'checked' : ''}/><span class="keep-opt"><strong>${title}</strong><small>${text}</small></span></label>`;
        return (
          `<label class="switch"><input type="checkbox" id="pf-study" ${store.study ? 'checked' : ''}/><span>Study mode</span></label>` +
          `<p class="muted small">Shows the PDF on the left and a notebook on the right. Write with the pen on either side. Switch a note page between lined, grid and blank in the notebook bar.</p>` +
          section(
            'How to keep your notes',
            opt('device', 'Keep notes separately (recommended)', 'Your book stays untouched. Marks and notes are saved on this device as you write, and come back when you open the book again, at the page where you stopped. Use Save ▾ → PDF with my notes to share or print them.') +
              opt('file', 'Write notes into the book', 'Save puts your marks and note pages into the book file itself, so they travel with it to other devices and apps. Saving rewrites the whole file, which takes longer for very large books.') +
              (doc?.bookId ? `<p class="muted small">${doc.keep === 'device' ? 'This book: notes are kept on this device.' : 'This book: notes go into the file when you save.'}</p>` : ''),
          ) +
          section(
            'Notes',
            `<p class="muted small">${notes} note page${notes === 1 ? '' : 's'} in this book.</p>` +
              `<div class="btn-row">${notes ? `<button class="btn" type="button" data-act="save-notes">${icon('save')}Save notes only</button>` : ''}${doc?.bookId ? `<button class="btn" type="button" data-act="backup-notes">${icon('backup')}Back up (.nibe)</button>` : ''}</div>`,
          )
        );
      }
      case 'settings':
        return this.settingsView();
      case 'check':
        return this.checkView();
      default:
        return '';
    }
  }

  private myStampsHtml(): string {
    const list = myStamps();
    const grid = list.length
      ? `<ul class="my-stamps">${list
          .map(
            (st) =>
              `<li><button type="button" class="my-stamp" data-use-stamp="${st.id}" title="Place “${esc(st.name)}”"><img src="${st.thumb}" alt=""/><span>${esc(st.name)}</span></button><span class="my-stamp-acts">${st.design ? `<button type="button" class="icon-btn sm" data-edit-stamp="${st.id}" title="Edit">${icon('edit')}</button>` : ''}<button type="button" class="icon-btn sm danger" data-del-stamp="${st.id}" title="Delete">${icon('trash')}</button></span></li>`,
          )
          .join('')}</ul>`
      : `<p class="muted small">Design your own stamp, or use a PNG picture such as a company seal or a scanned signature stamp.</p>`;
    return `${grid}<div class="btn-row"><button class="btn" type="button" data-act="stamp-design">${icon('edit')}Design a stamp</button><button class="btn" type="button" data-act="stamp-png">${icon('image')}Add PNG…</button></div><p class="muted small">Kept in this browser only.</p>`;
  }

  private settingsView(): string {
    const p = store.prefs;
    return (
      section(
        'Interface size',
        `<div class="seg">${UI_SIZES.map((v) => `<label class="seg-opt"><input type="radio" name="pf-ui" value="${v}" ${Math.abs(p.uiScale - v) < 0.01 ? 'checked' : ''}/><span>${Math.round(v * 100)}%</span></label>`).join('')}</div>
         <p class="muted small">Makes Nib-E's buttons and text bigger or smaller. Pages have their own zoom at the bottom.</p>`,
      ) +
      section(
        'Appearance',
        `<div class="seg">${(
          [
            ['system', 'Automatic'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ] as const
        )
          .map(([v, l]) => `<label class="seg-opt"><input type="radio" name="pf-theme" value="${v}" ${p.theme === v ? 'checked' : ''}/><span>${l}</span></label>`)
          .join('')}</div>
         <p class="muted small">Automatic follows your system's light or dark setting.</p>`,
      ) +
      section(
        'Pen feel',
        `<div class="seg">${(['precise', 'balanced', 'smooth'] as const).map((v) => `<label class="seg-opt"><input type="radio" name="pf-feel" value="${v}" ${p.penFeel === v ? 'checked' : ''}/><span>${FEEL_LABEL[v]}</span></label>`).join('')}</div>
         <p class="muted small">How much your writing is smoothed. <strong>Precise</strong> follows the pen tip (handwriting), <strong>Smooth</strong> evens out long lines and diagrams. Applies to new strokes.</p>`,
      ) +
      section(
        'Spelling',
        `<label class="switch"><input type="checkbox" id="pf-spell" ${p.spellcheck ? 'checked' : ''}/><span>Check spelling while typing</span></label>
         <label class="field-label sm">Language<select class="text-input" id="pf-spell-lang">${SPELL_LANGS.map(([v, l]) => `<option value="${v}" ${p.spellLang === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
         <p class="muted small">Uses your browser's own dictionary, on this device. Right-click a word underlined in red for suggestions. Some browsers only check languages enabled in their settings.</p>`,
      ) +
      section(
        'Saving',
        `<label class="switch"><input type="checkbox" id="pf-backup" ${p.keepBackup ? 'checked' : ''}/><span>Keep the earlier version when saving over a file</span></label>
         <p class="muted small">One earlier version per file, kept on this device. Get it back with Save ▾ → Restore earlier version.</p>`,
      ) +
      section(
        'Privacy',
        `<div class="net-row">${icon('network')}<span><strong>Network: none</strong><small>${isDesktop() ? 'The Nib-E app has no permission to use the internet. It cannot send or receive anything.' : 'Once loaded, this page is blocked from connecting anywhere (its security rules allow no network requests). Your files never leave this device.'}</small></span></div>
         <p class="muted small">${isDesktop() ? 'This app' : 'This browser'} keeps only your settings, a signature you chose to remember, your stamps, study notes, unsaved-work copies and earlier versions of saved files.</p>
         <button class="btn btn-quiet wide" type="button" data-act="forget">${icon('trash')}Forget everything saved ${isDesktop() ? 'in this app' : 'in this browser'}</button>`,
      ) +
      section('Help', actBtn('help', 'help', 'Open the tour')) +
      section(
        'Version',
        `<p class="muted small mono">Nib-E ${VERSION} · ${buildLabel(isDesktop())}</p>
         <p class="muted small">${updateNote(isDesktop())}</p>
         ${isDesktop() && EDITION !== 'store' ? `<button class="btn wide" type="button" data-act="latest">${icon('open')}Get the latest version</button><p class="muted small">Opens the website in your normal browser. Nib-E itself stays offline.</p>` : ''}`,
      )
    );
  }

  private hfView(hf: HeaderFooter | null): string {
    const v = hf ?? DEFAULT_HF;
    const row = (part: 'header' | 'footer') =>
      `<div class="tri">${['Left', 'Centre', 'Right'].map((l, i) => `<label class="field-label sm">${l}<input class="text-input" id="hf-${part}-${i}" value="${esc(v[part][i])}"/></label>`).join('')}</div>`;
    return (
      section('Header', row('header')) +
      section('Footer', row('footer')) +
      `<div class="tri"><label class="field-label sm">Size<input class="text-input" type="number" id="hf-size" min="5" max="24" value="${v.size}"/></label><label class="field-label sm">Margin<input class="text-input" type="number" id="hf-margin" min="6" max="72" value="${v.margin}"/></label><label class="field-label sm">Colour<input class="text-input color" type="color" id="hf-color" value="${v.color}"/></label></div>` +
      `<p class="muted small">Use <code>{page}</code>, <code>{pages}</code>, <code>{date}</code> and <code>{file}</code>. Applies to every document page (not notes).</p>` +
      `<div class="btn-row"><button class="btn btn-primary" type="button" data-act="hf-apply">${hf ? 'Update' : 'Add'}</button>${hf ? `<button class="btn btn-quiet" type="button" data-act="hf-remove">Remove</button>` : ''}</div>`
    );
  }

  private wmView(wm: Watermark | null): string {
    const v = wm ?? DEFAULT_WM;
    return (
      `<label class="field-label">Text<input class="text-input" id="wm-text" maxlength="40" value="${esc(v.text)}"/></label>` +
      `<div class="tri"><label class="field-label sm">Size<input class="text-input" type="number" id="wm-size" min="12" max="200" value="${v.size}"/></label><label class="field-label sm">Colour<input class="text-input color" type="color" id="wm-color" value="${v.color}"/></label><label class="field-label sm">Opacity<input type="range" id="wm-opacity" min="0.05" max="0.8" step="0.05" value="${v.opacity}"/></label></div>` +
      `<label class="switch"><input type="checkbox" id="wm-diag" ${v.diagonal ? 'checked' : ''}/><span>Diagonal</span></label>` +
      `<div class="btn-row"><button class="btn btn-primary" type="button" data-act="wm-apply">${wm ? 'Update' : 'Add'}</button>${wm ? `<button class="btn btn-quiet" type="button" data-act="wm-remove">Remove</button>` : ''}</div>`
    );
  }

  private checkView(): string {
    const reports = store.doc?.reports ?? [];
    const blocked = reports.reduce((n, r) => n + r.report.findings.filter((f) => f.level === 'blocked').length, 0);
    const row = (f: Finding) =>
      `<li class="finding finding-${f.level}"><span class="finding-icon">${icon(f.level === 'blocked' ? 'shieldAlert' : 'info')}</span><div><div class="finding-title">${esc(f.title)}${f.count > 1 ? ` <span class="count">${f.count}</span>` : ''}</div><p>${esc(f.detail)}</p></div><span class="finding-state">${f.level === 'blocked' ? 'Blocked' : 'Info'}</span></li>`;
    const verdict = blocked
      ? `<div class="callout warn">${icon('shieldAlert')}<p><strong>${blocked} risky ${blocked === 1 ? 'item' : 'items'} blocked.</strong> The file tried to include active content. None of it ran.</p></div>`
      : `<div class="callout ok">${icon('shield')}<p><strong>No active content found.</strong> This file only contains pages, text and images${reports.some((r) => r.report.findings.some((f) => f.id === 'form')) ? ', plus a form' : ''}.</p></div>`;
    const files = reports
      .map(({ name, report }) => {
        const list = report.findings.length ? `<ul class="findings">${report.findings.map(row).join('')}</ul>` : '<p class="muted small">Nothing to report.</p>';
        const meta = [`${report.pageCount} page${report.pageCount === 1 ? '' : 's'}`, report.encrypted ? 'password protected' : '', report.pagesScanned < report.pageCount ? `links checked on the first ${report.pagesScanned} pages` : ''].filter(Boolean).join(' · ');
        return `<section class="file-report"><h3>${esc(name)}</h3><p class="file-meta">${esc(meta)}</p>${list}</section>`;
      })
      .join('');
    const promises = [
      ['shield', 'Scripts never run', 'The PDF engine in Nib-E has no JavaScript runtime.'],
      ['link', 'Links stay inert', 'Nothing opens a website, program or other file.'],
      ['lock', 'Files stay on this device', 'Opening and saving happen locally. Nothing is uploaded.'],
    ];
    return `${verdict}${files}<h3 class="panel-sub">Always on</h3><ul class="guarantees">${promises.map(([i, t, d]) => `<li>${icon(i)}<div><strong>${t}</strong><p>${d}</p></div></li>`).join('')}</ul><p class="muted small">The keyword scan can miss items hidden inside compressed parts of a file. Nib-E blocks these features either way.</p>`;
  }

  // ---------- events ----------

  private readHf(): HeaderFooter {
    const val = (id: string) => (this.body.querySelector(`#${id}`) as HTMLInputElement).value;
    const num = (id: string, d: number) => Number(val(id)) || d;
    return {
      header: [val('hf-header-0'), val('hf-header-1'), val('hf-header-2')],
      footer: [val('hf-footer-0'), val('hf-footer-1'), val('hf-footer-2')],
      size: Math.min(24, Math.max(5, num('hf-size', 9))),
      margin: Math.min(72, Math.max(6, num('hf-margin', 24))),
      color: val('hf-color'),
    };
  }

  private readWm(): Watermark {
    const val = (id: string) => (this.body.querySelector(`#${id}`) as HTMLInputElement).value;
    return {
      text: val('wm-text').trim() || 'CONFIDENTIAL',
      size: Math.min(200, Math.max(12, Number(val('wm-size')) || 64)),
      color: val('wm-color'),
      opacity: Number(val('wm-opacity')) || 0.18,
      diagonal: (this.body.querySelector('#wm-diag') as HTMLInputElement).checked,
    };
  }

  private radio(name: string): string {
    return (this.body.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? '';
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement;
    switch (el.id) {
      case 'pf-show':
        store.setFieldsOn(el.checked);
        break;
      case 'pf-spell':
        store.setPrefs({ spellcheck: el.checked });
        break;
      case 'pf-spell-lang':
        store.setPrefs({ spellLang: el.value });
        break;
      case 'pf-fillable':
        store.setPrefs({ fillable: el.checked });
        break;
      case 'pf-backup':
        store.setPrefs({ keepBackup: (el as HTMLInputElement).checked });
        break;
      case 'pf-sanitize':
        store.setPrefs({ sanitize: el.checked });
        break;
      case 'pf-raster':
        store.setPrefs({ rasterize: el.checked });
        break;
      case 'pf-stamp-date':
        store.setPrefs({ stampDate: el.checked });
        break;
      case 'pf-study':
        store.setStudy(el.checked);
        break;
    }
    if (el.name === 'pf-ui') store.setPrefs({ uiScale: Number(el.value) || 1.5 });
    if (el.name === 'pf-keep') {
      const v = el.value as 'device' | 'file';
      store.setPrefs({ studyKeep: v });
      if (store.doc) void setKeep(store.doc, v).then(() => toast(v === 'device' ? 'Notes are kept on this device. The book file stays as it was.' : 'Notes go into the book file when you save (Ctrl+S).', 'ok', 5000));
    }
    if (el.name === 'pf-theme') store.setPrefs({ theme: el.value as 'system' | 'light' | 'dark' });
    if (el.name === 'pf-feel') store.setPrefs({ penFeel: el.value as 'precise' | 'balanced' | 'smooth' });
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const b = (e.target as HTMLElement).closest('button, [data-view]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    if (b.dataset.view) {
      store.setPanel(b.dataset.view as PanelView);
      return;
    }
    if (b.dataset.tool) {
      store.setTool(b.dataset.tool as Tool);
      return;
    }
    if (b.dataset.page) {
      this.host.scrollToPage(Number(b.dataset.page));
      return;
    }
    if (b.dataset.useStamp) {
      if (await useStamp(b.dataset.useStamp)) toast('Click on a page to place the stamp.');
      return;
    }
    if (b.dataset.editStamp) {
      const st = myStamps().find((x) => x.id === b.dataset.editStamp);
      if (st && (await openStampMaker(st))) this.render();
      return;
    }
    if (b.dataset.delStamp) {
      deleteStamp(b.dataset.delStamp);
      this.render();
      return;
    }
    if (b.dataset.stamp) {
      store.setPrefs({ stamp: { label: b.dataset.stamp, color: b.dataset.color! } });
      store.setTool('stamp');
      return;
    }
    const act = b.dataset.act;
    if (!act) return;
    if (act.startsWith('view:')) {
      store.setPanel(act.slice(5) as PanelView);
      return;
    }
    if (b.getAttribute('type') === 'submit') e.preventDefault();
    const keys = store.targetKeys();
    switch (act) {
      case 'rotL':
        store.rotate(keys, -1);
        break;
      case 'rotR':
        store.rotate(keys, 1);
        break;
      case 'up':
        store.shift(keys, -1);
        break;
      case 'down':
        store.shift(keys, 1);
        break;
      case 'delete':
        if (keys.length >= store.pages.length) toast('A PDF needs at least one page.', 'error');
        else {
          store.remove(keys);
          store.selected.clear();
          store.emit('selection');
          toast(`${keys.length === 1 ? 'Page' : `${keys.length} pages`} deleted. Undo brings ${keys.length === 1 ? 'it' : 'them'} back.`);
        }
        break;
      case 'extract':
        if (keys.length) await this.host.busy('Saving pages…', () => saveSelection(keys));
        break;
      case 'select-all':
        store.pages.forEach((p) => store.selected.add(p.key));
        store.emit('selection');
        this.render();
        break;
      case 'insert-blank':
      case 'insert-lined':
      case 'insert-grid': {
        const t = act.slice(7) as Template;
        const cur = store.pages[store.current];
        const size = cur ? shownSize(cur) : { w: 595.28, h: 841.89 };
        const key = uid('p');
        store.insertBlank(store.current, t, size.w, size.h, key);
        const i = store.pages.findIndex((p) => p.key === key);
        requestAnimationFrame(() => this.host.scrollToPage(i));
        break;
      }
      case 'image': {
        const [file] = await pick('image/*', false);
        if (!file) return;
        const img = await this.host.busy('Loading image…', () => loadImage(file));
        if (!img) return;
        store.pendingImage = img.id;
        store.pendingImageSize = 220;
        store.setTool('image');
        this.render();
        toast('Click on a page to place the image.');
        break;
      }
      case 'hf-apply':
        store.commit({ hf: this.readHf() }, 'decor');
        toast('Header and footer added to every page.', 'ok');
        break;
      case 'hf-remove':
        store.commit({ hf: null }, 'decor');
        break;
      case 'wm-apply':
        store.commit({ wm: this.readWm() }, 'decor');
        toast('Watermark added to every page.', 'ok');
        break;
      case 'wm-remove':
        store.commit({ wm: null }, 'decor');
        break;
      case 'redraw':
        if (await openSignaturePad()) store.setTool('sign');
        break;
      case 'clear-answers':
        store.updatePages((p) => ({ ...p, items: p.items.filter((it) => !((it.type === 'text' || it.type === 'mark') && it.field)) }));
        break;
      case 'stamp-custom': {
        const text = (this.body.querySelector('#pf-stamp-text') as HTMLInputElement).value.trim().toUpperCase();
        if (!text) return;
        store.setPrefs({ stamp: { label: text, color: '#2f3fd6' } });
        store.setTool('stamp');
        break;
      }
      case 'find-mark': {
        const q = (this.body.querySelector('#pf-find') as HTMLInputElement).value;
        if (!q.trim()) return;
        const n = markSearch(q);
        toast(n ? `Marked ${n} match${n === 1 ? '' : 'es'} for “${q.trim()}”.` : `No text matches “${q.trim()}”.`, n ? 'ok' : 'info');
        break;
      }
      case 'mark-page': {
        const p = store.pages[store.current];
        if (p) markWholePage(p.key);
        break;
      }
      case 'redact-apply':
        this.host.applyRedactions();
        break;
      case 'redact-clear':
        store.updatePages((p) => ({ ...p, items: p.items.filter((it) => it.type !== 'redact') }));
        break;
      case 'merge': {
        const files = await pick('application/pdf,.pdf', true);
        for (const f of files) {
          const n = await this.host.busy('Adding…', () => mergeFile(f));
          if (n) toast(`Added ${n} page${n === 1 ? '' : 's'} from ${f.name}.`, 'ok');
        }
        break;
      }
      case 'add-images':
      case 'create-new': {
        const files = await pick('image/*', true);
        if (!files.length) return;
        const size = (this.radio('pf-size') || 'a4') as 'a4' | 'fit';
        const bytes = await this.host.busy('Building pages…', () => imagesAsPdf(files, size));
        if (!bytes) return;
        if (act === 'create-new') {
          await this.host.busy('Opening…', () => openBytes(`${files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'Images'}.pdf`, bytes));
          toast(`Created a PDF with ${files.length} page${files.length === 1 ? '' : 's'}.`, 'ok');
        } else {
          const n = await this.host.busy('Adding…', () => mergeBytes(`${files.length} images`, bytes));
          if (n) toast(`Added ${n} image page${n === 1 ? '' : 's'}.`, 'ok');
        }
        break;
      }
      case 'compress': {
        const q = this.radio('pf-q');
        const opts = q === 'high' ? { dpi: 150, quality: 0.82 } : q === 'small' ? { dpi: 72, quality: 0.6 } : { dpi: 110, quality: 0.7 };
        const r = await this.host.busy('Compressing…', () => compressAndSave(opts));
        if (!r) return;
        this.lastResult = r.images
          ? `${fmtBytes(r.before)} → ${fmtBytes(r.after)} (${Math.round((1 - r.after / r.before) * 100)}% smaller, ${r.images} image${r.images === 1 ? '' : 's'} scaled down).`
          : `Already compact (${fmtBytes(r.before)}). No large photos to shrink, so it was saved unchanged.`;
        this.render();
        break;
      }
      case 'protect': {
        const pw1 = (this.body.querySelector('#pf-pw1') as HTMLInputElement).value;
        const pw2 = (this.body.querySelector('#pf-pw2') as HTMLInputElement).value;
        if (pw1 !== pw2) {
          toast('The two passwords are different.', 'error');
          return;
        }
        const perms = {
          print: (this.body.querySelector('#pf-print') as HTMLInputElement).checked,
          copy: (this.body.querySelector('#pf-copy') as HTMLInputElement).checked,
          edit: (this.body.querySelector('#pf-edit') as HTMLInputElement).checked,
        };
        const r = await this.host.busy('Protecting…', () => protectAndSave(pw1, perms));
        if (r === 'saved') toast('Saved a password-protected copy.', 'ok');
        break;
      }
      case 'export': {
        const mime = this.radio('pf-fmt') as 'image/png' | 'image/jpeg';
        const dpi = Number(this.radio('pf-dpi')) || 150;
        const which = this.radio('pf-pages');
        const r = await this.host.busy('Rendering pages…', () => exportImages({ dpi, mime, keys: which === 'target' ? store.targetKeys() : undefined }));
        if (r === 'saved') toast('Images saved.', 'ok');
        break;
      }
      case 'fields-on':
        store.setFieldsOn(true);
        if (!['hand', 'select', 'text', 'mark'].includes(store.tool)) store.setTool('hand');
        break;
      case 'stamp-design': {
        const st = await openStampMaker();
        if (st) {
          this.render();
          if (await useStamp(st.id)) toast(`Saved “${st.name}”. Click on a page to place it.`, 'ok');
        }
        break;
      }
      case 'stamp-png': {
        const [file] = await pick('image/png,image/webp,image/jpeg,image/gif', false);
        if (!file) return;
        const st = await addPngStamp(file);
        if (st) {
          this.render();
          if (await useStamp(st.id)) toast(`Added “${st.name}”. Click on a page to place it.`, 'ok');
        }
        break;
      }
      case 'help':
        openHelp();
        break;
      case 'forget': {
        const { ask } = await import('./dialog');
        const r = await ask({
          title: isDesktop() ? 'Forget everything saved in this app?' : 'Forget everything saved in this browser?',
          body: '<p>Removes your settings, remembered signature, stamps, study notes kept on this device, unsaved-work copies and earlier versions of saved files. Open files and files on disk are not affected.</p>',
          actions: [
            { label: 'Cancel', value: false, kind: 'quiet' },
            { label: 'Forget', value: true, kind: 'danger' },
          ],
        });
        if (!r?.value) return;
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith('nib.')) localStorage.removeItem(k);
        } catch {
          /* storage unavailable */
        }
        await idbClear().catch(() => undefined);
        for (const t of store.tabs) t.bookId = null;
        store.emit('library');
        toast('Saved data removed from this browser.', 'ok');
        this.render();
        break;
      }
      case 'save-notes':
        await this.host.busy('Saving notes…', () => saveNotes());
        break;
      case 'backup-notes':
        if (store.doc) {
          const r = await this.host.busy('Saving…', () => exportBackup(store.doc!));
          if (r === 'saved') toast('Notes backup saved. Restore it from the start screen on another device.', 'ok');
        }
        break;
      case 'latest':
        await invoke('open_website').catch(() => toast('Could not open the browser.', 'error'));
        break;
    }
  }

  /** Called after a redaction run to show its report. */
  showResult(text: string): void {
    this.lastResult = text;
    this.render();
  }
}
