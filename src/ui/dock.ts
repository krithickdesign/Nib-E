// Floating tool dock: quick tools, options for the active tool, undo/redo, zoom.
import { HIGHLIGHT_COLORS, HIGHLIGHT_SIZES, PEN_COLORS, PEN_SIZES, type PenFeel } from '../ink/stroke';
import { pendingRedactions } from '../doc';
import { store, type Tool } from '../store';
import { icon } from './icons';
import { hasSignature, openSignaturePad } from './signature';
import { toast } from './toast';
export const FEEL_LABEL: Record<PenFeel, string> = { precise: 'Precise', balanced: 'Balanced', smooth: 'Smooth' };
export const FEEL_HINT: Record<PenFeel, string> = {
  precise: 'Pen feel: Precise. Follows your pen tip closely, best for handwriting.',
  balanced: 'Pen feel: Balanced. Light smoothing that keeps the corners of letters.',
  smooth: 'Pen feel: Smooth. Strong smoothing for long lines and diagrams.',
};
import { COLOR_NAMES, MARKUP_COLORS, NOTE_COLORS, QUICK_TOOLS, SHAPE_COLORS, TEXT_COLORS, TOOL_INFO } from './tools';

export interface DockHost {
  zoomBy(f: number): void;
  /** Sets the zoom of the document view (1 = 100 %). */
  zoomTo(z: number): void;
  fit(mode: 'width' | 'page'): void;
  applyRedactions(): void;
}

function swatches(colors: string[], current: string, prop: string): string {
  return colors.map((c) => `<button class="swatch" type="button" data-pref="${prop}" data-val="${c}" style="--sw:${c}" aria-label="${COLOR_NAMES[c] ?? c}" aria-pressed="${c === current}"></button>`).join('');
}

function choice(prop: string, current: string, opts: { val: string; icon: string; label: string }[]): string {
  return opts.map((o) => `<button class="opt" type="button" data-pref="${prop}" data-val="${o.val}" title="${o.label}" aria-label="${o.label}" aria-pressed="${o.val === current}">${icon(o.icon)}</button>`).join('');
}

const sep = '<span class="dock-mini-sep" aria-hidden="true"></span>';

const LAYOUTS: { id: 'single' | 'two' | 'cover'; icon: string; label: string }[] = [
  { id: 'single', icon: 'pageSingle', label: 'One page' },
  { id: 'two', icon: 'pageTwo', label: 'Two pages' },
  { id: 'cover', icon: 'pageCover', label: 'Two + title page' },
];

export class Dock {
  private toolsEl: HTMLElement;
  private optsEl: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private zoomLabel: HTMLButtonElement;
  private layoutBtn: HTMLButtonElement;

  constructor(root: HTMLElement, private host: DockHost) {
    root.innerHTML = `
      <div class="dock-group dock-tools" role="toolbar" aria-label="Tools"></div>
      <span class="dock-sep" aria-hidden="true"></span>
      <div class="dock-group dock-opts"></div>
      <span class="dock-sep" aria-hidden="true"></span>
      <div class="dock-group dock-hist">
        <button class="icon-btn" type="button" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('undo')}</button>
        <button class="icon-btn" type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('redo')}</button>
      </div>
      <button class="tool dock-more" type="button" data-act="more" title="Toolbox" aria-label="Toolbox">${icon('tools')}</button>
      <span class="dock-sep dock-zoom-sep" aria-hidden="true"></span>
      <div class="dock-group dock-zoom">
        <button class="icon-btn" type="button" data-act="zout" title="Zoom out (Ctrl −)" aria-label="Zoom out">${icon('minus')}</button>
        <button class="zoom-label" type="button" data-act="view" title="View: zoom, fit, two pages" aria-haspopup="dialog" aria-expanded="false"></button>
        <button class="icon-btn" type="button" data-act="zin" title="Zoom in (Ctrl +)" aria-label="Zoom in">${icon('plus')}</button>
        <button class="icon-btn dock-layout" type="button" data-act="layout"></button>
      </div>`;
    this.toolsEl = root.querySelector('.dock-tools')!;
    this.optsEl = root.querySelector('.dock-opts')!;
    this.undoBtn = root.querySelector('[data-act="undo"]')!;
    this.redoBtn = root.querySelector('[data-act="redo"]')!;
    this.zoomLabel = root.querySelector('.zoom-label')!;
    this.layoutBtn = root.querySelector('.dock-layout')!;
    // View options float above the dock (the dock itself scrolls sideways on small screens).
    this.pop = document.createElement('div');
    this.pop.className = 'view-pop';
    this.pop.hidden = true;
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'View');
    root.parentElement!.append(this.pop);
    this.pop.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.id === 'vp-zoom') this.host.zoomTo(Number(el.value) / 100);
    });
    this.pop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.fit) this.host.fit(b.dataset.fit as 'width' | 'page');
      if (b.dataset.spread) store.setPrefs({ spread: b.dataset.spread as 'single' | 'two' | 'cover' });
      this.renderPop();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.pop.hidden) return;
      const t = e.target as HTMLElement;
      if (!this.pop.contains(t) && !t.closest('.zoom-label')) this.togglePop(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.pop.hidden) this.togglePop(false);
    });

    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.tool) {
        store.setTool(b.dataset.tool as Tool);
        return;
      }
      if (b.dataset.pref) {
        this.setPref(b.dataset.pref, b.dataset.val!);
        return;
      }
      switch (b.dataset.act) {
        case 'undo':
          store.undo();
          break;
        case 'redo':
          store.redo();
          break;
        case 'zin':
          this.host.zoomBy(1.2);
          break;
        case 'zout':
          this.host.zoomBy(1 / 1.2);
          break;
        case 'view':
          this.togglePop(this.pop.hidden);
          break;
        case 'layout': {
          const next = LAYOUTS[(LAYOUTS.findIndex((l) => l.id === store.prefs.spread) + 1) % LAYOUTS.length];
          store.setPrefs({ spread: next.id });
          toast(next.label, 'info', 1500);
          break;
        }
        case 'finger':
          store.setPrefs({ fingerDraws: !store.prefs.fingerDraws });
          break;
        case 'feel': {
          const order: PenFeel[] = ['precise', 'balanced', 'smooth'];
          const next = order[(order.indexOf(store.prefs.penFeel) + 1) % order.length];
          store.setPrefs({ penFeel: next });
          toast(FEEL_HINT[next], 'info', 3500);
          break;
        }
        case 'resign':
          void openSignaturePad().then((s) => s && store.setTool('sign'));
          break;
        case 'stampDate':
          store.setPrefs({ stampDate: !store.prefs.stampDate });
          break;
        case 'redactApply':
          this.host.applyRedactions();
          break;
        case 'panel':
          store.setPanel(b.dataset.view as never);
          break;
        case 'more':
          if (store.prefs.rightOpen) store.setPrefs({ rightOpen: false });
          else store.setPanel('home');
          break;
      }
    });

    store.on((why) => {
      if (why === 'tool' || why === 'prefs') this.renderTools();
      if (why === 'items' || why === 'pages' || why === 'doc') {
        if (store.tool === 'redact') this.renderTools();
      }
      if (why === 'history' || why === 'doc') this.renderHistory();
      if (why === 'zoom' || why === 'doc') {
        this.zoomLabel.textContent = `${Math.round(store.zoom * 100)}%`;
        if (!this.pop.hidden) this.renderPop();
      }
      if (why === 'prefs' && !this.pop.hidden) this.renderPop();
      if (why === 'prefs' || why === 'doc') this.renderLayout();
    });
    this.renderLayout();
    this.renderTools();
    this.renderHistory();
  }

  private pop: HTMLDivElement;

  private togglePop(open: boolean): void {
    this.pop.hidden = !open;
    this.zoomLabel.setAttribute('aria-expanded', String(open));
    if (open) {
      this.renderPop();
      // The floating layer is scaled with the interface size (CSS zoom): work in screen pixels, then divide.
      const ui = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
      const r = this.zoomLabel.getBoundingClientRect();
      const host = this.pop.parentElement!.getBoundingClientRect();
      const w = this.pop.offsetWidth * ui;
      const left = Math.max(8, Math.min(host.width - w - 8, r.left + r.width / 2 - host.left - w / 2));
      this.pop.style.left = `${left / ui}px`;
      this.pop.style.bottom = `${(host.bottom - r.top + 10) / ui}px`;
    }
  }

  private renderPop(): void {
    const z = Math.round(store.zoom * 100);
    const sp = store.prefs.spread;
    const opt = (v: string, ic: string, label: string) => `<button type="button" class="vp-opt" data-spread="${v}" aria-pressed="${sp === v}">${icon(ic)}<span>${label}</span></button>`;
    const active = document.activeElement as HTMLElement | null;
    const sliding = active?.id === 'vp-zoom';
    if (sliding) {
      (this.pop.querySelector('#vp-zoom-out') as HTMLElement).textContent = `${z}%`;
      return;
    }
    this.pop.innerHTML = `
      <label class="vp-row"><span>Zoom</span><output id="vp-zoom-out">${z}%</output></label>
      <input type="range" id="vp-zoom" min="20" max="400" step="5" value="${Math.min(400, Math.max(20, z))}" aria-label="Zoom"/>
      <div class="vp-fit"><button type="button" class="btn sm" data-fit="width">${icon('fitWidth')}Fit width</button><button type="button" class="btn sm" data-fit="page">${icon('fitPage')}Fit page</button></div>
      <div class="vp-title">Pages</div>
      <div class="vp-spread">${opt('single', 'pageSingle', 'One page')}${opt('two', 'pageTwo', 'Two pages')}${opt('cover', 'pageCover', 'Two + title page')}</div>
      <p class="vp-hint">Page Down / Page Up, arrow keys and page-turn pedals turn ${sp === 'single' ? 'one page' : 'two pages'}.</p>`;
  }

  private setPref(prop: string, val: string): void {
    const t = store.tool;
    const num = Number(val);
    switch (prop) {
      case 'color':
        store.setPrefs(t === 'highlighter' ? { hlColor: val } : { penColor: val });
        break;
      case 'size':
        store.setPrefs(t === 'highlighter' ? { hlSize: num } : { penSize: num });
        break;
      default:
        store.setPrefs({ [prop]: Number.isNaN(num) ? val : num } as never);
    }
  }

  private renderHistory(): void {
    this.undoBtn.disabled = !store.canUndo;
    this.redoBtn.disabled = !store.canRedo;
  }

  /** The page layout button next to zoom: shows the current layout, a click switches to the next. */
  private renderLayout(): void {
    const i = Math.max(0, LAYOUTS.findIndex((l) => l.id === store.prefs.spread));
    const cur = LAYOUTS[i];
    const next = LAYOUTS[(i + 1) % LAYOUTS.length];
    this.layoutBtn.innerHTML = icon(cur.icon);
    this.layoutBtn.title = `${cur.label}. Click for ${next.label.toLowerCase()}`;
    this.layoutBtn.setAttribute('aria-label', `Page layout: ${cur.label}`);
  }

  private renderTools(): void {
    const t = store.tool;
    const extra = QUICK_TOOLS.includes(t) ? [] : [t];
    this.toolsEl.innerHTML = [...QUICK_TOOLS, ...extra]
      .map((id) => {
        const info = TOOL_INFO[id];
        return `<button class="tool${extra.includes(id) ? ' tool-extra' : ''}" type="button" data-tool="${id}" title="${info.label}${info.key ? ` (${info.key})` : ''}" aria-label="${info.label}" aria-pressed="${id === t}">${icon(info.icon)}</button>`;
      })
      .join('');
    const p = store.prefs;
    const touch = window.matchMedia('(pointer: coarse)').matches || store.penSeen;
    const finger = touch ? `<button class="pill ${p.fingerDraws ? 'on' : ''}" type="button" data-act="finger" aria-pressed="${p.fingerDraws}" title="When off, fingers scroll and only a pen draws">${icon('finger')}<span>${p.fingerDraws ? 'Finger draws' : 'Finger scrolls'}</span></button>` : '';
    let html = '';
    switch (t) {
      case 'pen':
      case 'highlighter': {
        const hl = t === 'highlighter';
        const colors = hl ? HIGHLIGHT_COLORS : PEN_COLORS;
        const sizes = hl ? HIGHLIGHT_SIZES : PEN_SIZES;
        const cur = hl ? p.hlColor : p.penColor;
        const curSize = hl ? p.hlSize : p.penSize;
        const maxSize = sizes[sizes.length - 1];
        html =
          swatches(colors, cur, 'color') +
          sep +
          sizes.map((s) => `<button class="size" type="button" data-pref="size" data-val="${s}" aria-label="Size ${s} pt" aria-pressed="${s === curSize}"><span style="--d:${Math.round(4 + (s / maxSize) * 12)}px;--c:${cur}"></span></button>`).join('') +
          (hl ? '' : `<button class="pill" type="button" data-act="feel" title="Pen feel: how much your writing is smoothed. Click to change." aria-label="Pen feel: ${FEEL_LABEL[p.penFeel]}">${icon('wand')}<span>${FEEL_LABEL[p.penFeel]}</span></button>`) +
          finger;
        break;
      }
      case 'eraser':
        html = `<span class="dock-hint">Drag over ink, shapes or highlights</span>${finger}`;
        break;
      case 'select':
        html = `<span class="dock-hint">Click to select · drag to move · Delete removes</span>`;
        break;
      case 'hand':
        html = `<span class="dock-hint">Drag to scroll · click a form box to type</span>`;
        break;
      case 'text':
        html = `<span class="dock-hint">Click to type · click a form box to fill it</span>`;
        break;
      case 'sign':
        html = hasSignature()
          ? `<span class="dock-hint">Tap a page to place your signature</span><button class="pill" type="button" data-act="resign">Redraw</button>`
          : `<button class="pill on" type="button" data-act="resign">${icon('sign')}<span>Draw signature</span></button>`;
        break;
      case 'mark':
        html =
          choice('markShape', p.markShape, [
            { val: 'check', icon: 'check', label: 'Checkmark' },
            { val: 'cross', icon: 'cross', label: 'Cross' },
            { val: 'dot', icon: 'dot', label: 'Dot' },
          ]) +
          sep +
          swatches(TEXT_COLORS, p.textColor, 'textColor');
        break;
      case 'note':
        html = swatches(NOTE_COLORS, p.noteColor, 'noteColor') + `<span class="dock-hint">Click to add a note</span>`;
        break;
      case 'shape':
        html =
          choice('shape', p.shape, [
            { val: 'rect', icon: 'rect', label: 'Rectangle' },
            { val: 'ellipse', icon: 'ellipse', label: 'Ellipse' },
            { val: 'line', icon: 'line', label: 'Line' },
            { val: 'arrow', icon: 'arrow', label: 'Arrow' },
          ]) +
          sep +
          swatches(SHAPE_COLORS, p.shapeColor, 'shapeColor') +
          sep +
          [1, 2.5, 4].map((w) => `<button class="size" type="button" data-pref="shapeWidth" data-val="${w}" aria-label="Line ${w} pt" aria-pressed="${w === p.shapeWidth}"><span style="--d:${Math.round(3 + w * 2.5)}px;--c:${p.shapeColor}"></span></button>`).join('');
        break;
      case 'markup':
        html =
          choice('markup', p.markup, [
            { val: 'highlight', icon: 'markHighlight', label: 'Highlight' },
            { val: 'underline', icon: 'underline', label: 'Underline' },
            { val: 'strike', icon: 'strike', label: 'Strikethrough' },
          ]) +
          sep +
          swatches(MARKUP_COLORS.slice(0, 4), p.markupColor, 'markupColor') +
          `<span class="dock-hint">Drag across text</span>`;
        break;
      case 'stamp':
        html = `<span class="stamp-chip" style="--c:${p.stamp.color}">${p.stamp.label}</span><button class="pill ${p.stampDate ? 'on' : ''}" type="button" data-act="stampDate" aria-pressed="${p.stampDate}">${icon('date')}<span>Date</span></button><button class="pill" type="button" data-act="panel" data-view="stamp">Change</button>`;
        break;
      case 'image':
        html = store.pendingImage ? `<span class="dock-hint">Click where the image should go</span>` : `<button class="pill on" type="button" data-act="panel" data-view="edit">Choose an image</button>`;
        break;
      case 'link':
        html = `<span class="dock-hint">Drag a box, then enter a web address</span>`;
        break;
      case 'retype':
        html = `<span class="dock-hint">Click a line of the PDF's text to change it</span>`;
        break;
      case 'redact': {
        const n = pendingRedactions();
        html = `<span class="dock-hint">Drag over anything to mark it</span>${n ? `<button class="pill danger" type="button" data-act="redactApply">Apply ${n} mark${n > 1 ? 's' : ''}</button>` : ''}`;
        break;
      }
      case 'crop':
        html = `<span class="dock-hint">Drag over the part of the page to keep</span>`;
        break;
      case 'field':
        html = choice('fieldKind', p.fieldKind, [
          { val: 'text', icon: 'text', label: 'Text field' },
          { val: 'check', icon: 'check', label: 'Checkbox' },
        ]) + `<span class="dock-hint">Drag to draw a field</span>`;
        break;
    }
    this.optsEl.innerHTML = html;
  }
}
