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

export class Dock {
  private toolsEl: HTMLElement;
  private optsEl: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private zoomLabel: HTMLButtonElement;

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
      <button class="tool dock-more" type="button" data-act="more" title="All tools" aria-label="All tools">${icon('tools')}</button>
      <span class="dock-sep dock-zoom-sep" aria-hidden="true"></span>
      <div class="dock-group dock-zoom">
        <button class="icon-btn" type="button" data-act="zout" title="Zoom out (Ctrl −)" aria-label="Zoom out">${icon('minus')}</button>
        <button class="zoom-label" type="button" data-act="fit" title="Fit to width (Ctrl 0)"></button>
        <button class="icon-btn" type="button" data-act="zin" title="Zoom in (Ctrl +)" aria-label="Zoom in">${icon('plus')}</button>
      </div>`;
    this.toolsEl = root.querySelector('.dock-tools')!;
    this.optsEl = root.querySelector('.dock-opts')!;
    this.undoBtn = root.querySelector('[data-act="undo"]')!;
    this.redoBtn = root.querySelector('[data-act="redo"]')!;
    this.zoomLabel = root.querySelector('.zoom-label')!;

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
        case 'fit':
          this.host.fit(store.fitMode === 'width' ? 'page' : 'width');
          break;
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
        this.zoomLabel.title = store.fitMode === 'width' ? 'Fit whole page' : 'Fit to width (Ctrl 0)';
      }
    });
    this.renderTools();
    this.renderHistory();
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
      case 'redact': {
        const n = pendingRedactions();
        html = `<span class="dock-hint">Drag over anything to mark it</span>${n ? `<button class="pill danger" type="button" data-act="redactApply">Apply ${n} mark${n > 1 ? 's' : ''}</button>` : ''}`;
        break;
      }
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
