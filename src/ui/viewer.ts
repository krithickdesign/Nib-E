// The page view. One Viewer shows the document pages; in study mode a second
// one shows the notebook. Handles rendering, zoom, and every tool's pointer
// input: pen, eraser, text boxes, form boxes, shapes, notes, stamps, images,
// links, redaction marks, text markup and selection (move / resize / delete).
import { drawLive, inkHits, segmentHits, Smoother, type PenFeel } from '../ink/stroke';
import {
  contentSize,
  isBoxItem,
  itemBounds,
  moveItem,
  pageMatrix,
  rectToPage,
  rectToScreen,
  shownSize,
  sameSpot,
  toPage,
  totalRot,
  uid,
  uprightRot,
  visibleShown,
  visibleSize,
  type FieldItem,
  type InkItem,
  type Item,
  type MarkItem,
  type NoteItem,
  type PageEntry,
  type Pt,
  type Rect,
  type ShapeItem,
  type StampItem,
  type TextItem,
} from '../model';
import { baseName, lineAt, lineBackground, pageChars } from '../doc';
import { removalArea } from '../pdf/retype';
import type { DetectedField } from '../pdf/detect';
import { lineRects, type PChar } from '../pdf/text';
import { store, type Tool } from '../store';
import { drawDecor, drawItems, images, layoutText, measure, previewFont, stampLayout, textCss } from './draw';
import { FIELD_TOOLS, FormLayer } from './forms';
import { bitmapKey, cancelRender, PT_TO_PX, requestRender } from './render';
import { getSignature, placeSignature } from './signature';
import { spelling } from './spelling';
import { toast } from './toast';

const MAX_CANVAS_PX = 14_000_000;

interface Card {
  key: string;
  entry: PageEntry;
  wrap: HTMLDivElement;
  paper: HTMLDivElement;
  pdf: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  live: HTMLCanvasElement | null;
  caption: HTMLDivElement;
  fieldsEl: HTMLDivElement;
  forms: FormLayer | null;
  bmpKey: string;
  bmpScale: number;
  inkKey: unknown[] | null;
  visible: boolean;
  hide: Set<string>;
  override: Map<string, Item>;
}

type Session =
  | { kind: 'ink'; id: number; card: Card; pts: Pt[]; sim: boolean; smooth: Smoother; feel: PenFeel; tool: 'pen' | 'highlighter'; color: string; size: number; scale: number; raf: number }
  | { kind: 'erase'; id: number; card: Card; erased: Set<string> }
  | { kind: 'pan'; id: number; x: number; y: number }
  | { kind: 'move'; id: number; card: Card; item: Item; x0: number; y0: number; moved: boolean }
  | { kind: 'resize'; id: number; card: Card; item: Item; handle: string; start: Rect; x0: number; y0: number }
  | { kind: 'rect'; id: number; card: Card; tool: Tool; x0: number; y0: number; x1: number; y1: number; band: HTMLDivElement }
  | { kind: 'markup'; id: number; card: Card; chars: PChar[]; from: number; to: number; raf: number }
  | { kind: 'textsel'; id: number; card: Card; chars: PChar[]; from: number; to: number; cx: number; cy: number; moved: boolean; clicks: number }
  | { kind: 'tap'; id: number; card: Card; tool: Tool; x: number; y: number; cx: number; cy: number };

interface EditState {
  card: Card;
  item: TextItem;
  isNew: boolean;
  ta: HTMLTextAreaElement;
}

/** Puts text on the clipboard (with a fallback for older web views). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function dpr(): number {
  return Math.min(window.devicePixelRatio || 1, 3);
}

function fitScale(e: PageEntry, scale: number): number {
  const area = e.w * e.h * scale * scale;
  return area > MAX_CANVAS_PX ? Math.sqrt(MAX_CANVAS_PX / (e.w * e.h)) : scale;
}

/** The first-time hint for Edit text was shown. */
let retypeTold = false;

/** The text box being edited (shared by both viewers and the text toolbar). */
let editing: (EditState & { viewer: Viewer }) | null = null;

export function editingText(): TextItem | null {
  return editing?.item ?? null;
}

/** Applies font changes from the text toolbar to the box being edited or the selected one. */
export function applyTextStyle(patch: Partial<Pick<TextItem, 'font' | 'size' | 'bold' | 'italic' | 'color' | 'align'>>): void {
  if (editing) {
    editing.viewer.restyleEdit(patch);
    return;
  }
  const sel = store.sel;
  const it = sel && store.findItem(sel.key, sel.id);
  if (it && it.type === 'text') {
    const next: TextItem = { ...it, ...patch };
    store.replaceItem(sel!.key, fitText(next));
  }
}

/** Free text boxes grow to fit their text; form answers keep their box. */
function fitText(t: TextItem): TextItem {
  if (t.field || t.wrap) {
    if (t.wrap && !t.field) {
      const lay = layoutText(t);
      const h = Math.max(t.h, lay.needH);
      return t.rot % 2 ? { ...t, w: h } : { ...t, h };
    }
    return t;
  }
  const lay = layoutText({ ...t, wrap: false });
  const cw = Math.max(t.size * 2, lay.needW + 2);
  const ch = Math.max(t.size * 1.4, lay.needH);
  // Grow from the top-left corner of the upright content box; right-aligned
  // text grows to the left and centred text both ways (upright boxes).
  if (!t.rot && t.align && t.align !== 'left') {
    const dx = t.align === 'right' ? t.w - cw : (t.w - cw) / 2;
    return { ...t, x: t.x + dx, w: cw, h: ch };
  }
  return t.rot % 2 ? { ...t, w: ch, h: cw } : { ...t, w: cw, h: ch };
}

export class Viewer {
  private cards = new Map<string, Card>();
  private io: IntersectionObserver;
  private session: Session | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; mx: number; my: number } | null = null;
  /** Touch and hold on a mark selects it (phones have no right-click). */
  private hold: { timer: number; x: number; y: number; id: number } | null = null;
  private scrollRaf = 0;
  private pinnedUntil = 0;
  private selBox: HTMLDivElement;
  /** Selected PDF text (Select tool): one page at a time. */
  private textSel: { card: Card; chars: PChar[]; from: number; to: number } | null = null;
  private textSelEl: HTMLDivElement | null = null;
  private lastDown = { t: 0, x: 0, y: 0, n: 0 };
  private notePop: HTMLDivElement | null = null;

  constructor(
    private scroller: HTMLElement,
    private pagesEl: HTMLElement,
    readonly list: 'pages' | 'notes',
  ) {
    this.io = new IntersectionObserver((l) => this.onVisibility(l), { root: scroller, rootMargin: '900px 0px' });
    this.selBox = document.createElement('div');
    this.selBox.className = 'sel-box';
    this.selBox.innerHTML = ['nw', 'ne', 'sw', 'se'].map((h) => `<span class="handle h-${h}" data-h="${h}"></span>`).join('');
    this.selBox.addEventListener('pointerdown', (e) => this.onSelDown(e));
    store.on((why) => {
      if (why === 'doc') this.reset();
      else if (why === 'pages' || why === 'items' || why === 'notes') this.sync();
      else if (why === 'decor') this.repaintAll();
      else if (why === 'zoom' && this.isMain()) this.layout();
      else if (why === 'tool' || why === 'prefs') {
        this.applyTool();
        if (why === 'prefs' && this.isMain()) this.applySpread();
      }
      else if (why === 'selection') this.renderSelection();
      else if (why === 'fields') this.renderAllFields();
      else if (why === 'formvalues') for (const c of this.cards.values()) if (c.visible) c.forms?.refresh();
    });
    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    new ResizeObserver(() => {
      const mode = this.isMain() ? store.fitMode : this.ownFit;
      if (mode) this.fit(mode);
    }).observe(scroller);
    pagesEl.addEventListener('pointerdown', (e) => this.onDown(e));
    pagesEl.addEventListener('pointermove', (e) => this.onMove(e));
    pagesEl.addEventListener('pointerup', (e) => this.onUp(e));
    pagesEl.addEventListener('pointercancel', (e) => this.onUp(e, true));
    pagesEl.addEventListener('dblclick', (e) => this.onDouble(e));
    pagesEl.addEventListener('contextmenu', (e) => {
      // Typing keeps the normal menu: it has the spelling suggestions.
      if ((e.target as HTMLElement).closest('textarea, input')) return;
      if (store.tool !== 'hand' && store.tool !== 'select') e.preventDefault();
    });
    this.applyTool();
    this.applySpread();
  }

  private spreadOn = 'single';

  /** Two pages side by side (main viewer only), optionally with the title page alone. */
  private applySpread(): void {
    const s = this.isMain() ? store.prefs.spread : 'single';
    if (s === this.spreadOn) return;
    this.spreadOn = s;
    this.pagesEl.classList.toggle('spread', s !== 'single');
    this.pagesEl.classList.toggle('spread-cover', s === 'cover');
    const mode = store.fitMode;
    if (mode) this.fit(mode);
    requestAnimationFrame(() => this.scrollToPage(store.current, false));
  }

  /** Pages shown next to each other in a row. */
  private perRow(): number {
    return this.spreadOn === 'single' ? 1 : 2;
  }

  /** First page of the row (spread) that page i is in. */
  spreadStart(i: number): number {
    if (this.spreadOn === 'two') return i - (i % 2);
    if (this.spreadOn === 'cover') return i === 0 ? 0 : i - ((i - 1) % 2);
    return i;
  }

  /** The pages are wider than the pane (left/right arrows then scroll instead of turning pages). */
  scrollsSideways(): boolean {
    return this.scroller.scrollWidth > this.scroller.clientWidth + 2;
  }

  /** Index of the next (dir 1) or previous (dir -1) row's first page. */
  turn(from: number, dir: 1 | -1): number {
    const n = this.entries().length;
    if (this.spreadOn === 'single') return Math.max(0, Math.min(n - 1, from + dir));
    const start = this.spreadStart(from);
    if (dir > 0) {
      const next = this.spreadOn === 'cover' && start === 0 ? 1 : start + 2;
      return next < n ? next : start;
    }
    if (start === 0) return 0;
    return this.spreadStart(start - 1);
  }

  private isMain(): boolean {
    return this.list === 'pages';
  }

  private entries(): PageEntry[] {
    return this.list === 'pages' ? store.pages : store.notes;
  }

  // The document viewer uses the shared zoom (shown in the dock); the
  // notebook keeps its own so each pane fits its own width.
  private ownZoom = 1;
  private ownFit: 'width' | 'page' | null = 'width';

  get zoom(): number {
    return this.isMain() ? store.zoom : this.ownZoom;
  }

  private setZoom(z: number, fit: 'width' | 'page' | null = null): void {
    if (this.isMain()) {
      store.setZoom(z, fit);
      return;
    }
    const next = Math.min(6, Math.max(0.2, z));
    this.ownFit = fit;
    if (Math.abs(next - this.ownZoom) < 1e-4) return;
    this.ownZoom = next;
    this.layout();
  }

  /** Points-to-CSS-pixels factor at the current zoom. */
  get k(): number {
    return this.zoom * PT_TO_PX;
  }

  // ---------- structure ----------

  reset(): void {
    // Switching tabs: come back to the page that file was on.
    const target = this.isMain() ? store.current : 0;
    this.finishEdit(false);
    this.closeNote();
    this.clearTextSelection();
    for (const c of this.cards.values()) this.dropCard(c);
    this.cards.clear();
    this.pagesEl.textContent = '';
    this.sync();
    if (this.isMain()) this.fit('width');
    this.scroller.scrollTo({ top: 0, left: 0 });
    if (target > 0 && target < this.entries().length) this.scrollToPage(target, false);
  }

  /** Scroll position, to come back to it after the document is replaced (redaction). */
  get scrollPos(): { top: number; left: number } {
    return { top: this.scroller.scrollTop, left: this.scroller.scrollLeft };
  }

  restoreScroll(pos: { top: number; left: number }): void {
    requestAnimationFrame(() => requestAnimationFrame(() => this.scroller.scrollTo({ top: pos.top, left: pos.left })));
  }

  /** Key of the page in view (the one at the upper third of the pane). */
  visibleKey(): string | null {
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let best: string | null = null;
    for (const p of this.entries()) {
      const c = this.cards.get(p.key);
      if (!c) continue;
      if (best === null || c.wrap.offsetTop <= mid) best = p.key;
    }
    return best;
  }

  private makeCard(entry: PageEntry): Card {
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.dataset.key = entry.key;
    const paper = document.createElement('div');
    paper.className = 'paper';
    const pdf = document.createElement('canvas');
    pdf.className = 'layer-pdf';
    const ink = document.createElement('canvas');
    ink.className = 'layer-ink';
    const fieldsEl = document.createElement('div');
    fieldsEl.className = 'layer-fields';
    paper.append(pdf, ink, fieldsEl);
    const caption = document.createElement('div');
    caption.className = 'caption';
    wrap.append(paper, caption);
    const card: Card = { key: entry.key, entry, wrap, paper, pdf, ink, live: null, caption, fieldsEl, forms: null, bmpKey: '', bmpScale: 0, inkKey: null, visible: false, hide: new Set(), override: new Map() };
    if (entry.src !== null) card.forms = new FormLayer(paper, () => card.entry, () => this.k, () => this.refreshBitmap(card.entry.src!));
    fieldsEl.addEventListener('click', (e) => this.onFieldClick(card, e));
    this.io.observe(wrap);
    return card;
  }

  private dropCard(c: Card): void {
    this.io.unobserve(c.wrap);
    cancelRender(`v:${c.key}`);
    c.forms?.destroy();
    c.wrap.remove();
  }

  /** Bring cards in line with the page list (order, size, items). */
  sync(): void {
    const pages = this.entries();
    const keep = new Set(pages.map((p) => p.key));
    for (const [k, c] of this.cards) {
      if (!keep.has(k)) {
        this.dropCard(c);
        this.cards.delete(k);
      }
    }
    let prev: Element | null = null;
    pages.forEach((entry, i) => {
      let c = this.cards.get(entry.key);
      if (!c) {
        c = this.makeCard(entry);
        this.cards.set(entry.key, c);
      }
      const resized = c.entry.rot !== entry.rot || c.entry.w !== entry.w || c.entry.h !== entry.h || c.entry.crop !== entry.crop;
      c.entry = entry;
      const expected: Element | null = prev ? prev.nextElementSibling : this.pagesEl.firstElementChild;
      if (expected !== c.wrap) {
        if (prev) prev.after(c.wrap);
        else this.pagesEl.prepend(c.wrap);
      }
      prev = c.wrap;
      c.caption.textContent = this.isMain() ? `${i + 1}${entry.src === null ? ` · ${entry.template === 'blank' ? 'blank' : entry.template} page` : ''}` : `Note page ${i + 1}`;
      if (resized || !c.paper.style.width) {
        this.size(c);
        this.renderFields(c);
      }
      if (c.visible) this.paint(c);
    });
    const mode = this.isMain() ? store.fitMode : this.ownFit;
    if (mode) this.fit(mode);
    this.renderSelection();
    if (this.textSel) this.renderTextSelection();
  }

  private size(c: Card): void {
    const { w, h } = shownSize(c.entry);
    const k = this.k;
    c.paper.style.width = `${w * k}px`;
    c.paper.style.height = `${h * k}px`;
    // A cropped page shows only its visible part; with the Crop tool the whole page shows, the rest dimmed.
    const crop = c.entry.crop;
    const cropping = store.tool === 'crop' && this.isMain();
    const v = visibleShown(c.entry);
    const ins = [v.y, w - v.x - v.w, h - v.y - v.h, v.x].map((n) => `${Math.max(0, n) * k}px`);
    c.paper.classList.toggle('cropped', !!crop && !cropping);
    c.paper.style.clipPath = crop && !cropping ? `inset(${ins.join(' ')})` : '';
    c.paper.style.margin = crop && !cropping ? ins.map((x) => `-${x}`).join(' ') : '';
    let frame = c.paper.querySelector<HTMLElement>(':scope > .crop-frame');
    if (cropping) {
      if (!frame) {
        frame = document.createElement('div');
        frame.className = 'crop-frame';
        c.paper.append(frame);
      }
      Object.assign(frame.style, { left: `${v.x * k}px`, top: `${v.y * k}px`, width: `${v.w * k}px`, height: `${v.h * k}px` });
      frame.classList.toggle('none', !crop);
    } else frame?.remove();
  }

  private layout(): void {
    for (const c of this.cards.values()) {
      this.size(c);
      this.renderFields(c);
      if (c.visible) this.paint(c);
      c.forms?.layout();
    }
    this.renderSelection();
    this.renderTextSelection();
    if (editing && editing.viewer === this) this.placeEditor();
  }

  fit(mode: 'width' | 'page'): void {
    const pages = this.entries();
    if (!pages.length) return;
    const cs = getComputedStyle(this.pagesEl);
    const n = this.perRow();
    const gap = n > 1 ? parseFloat(cs.columnGap) || 0 : 0;
    const availW = (this.scroller.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 - gap * (n - 1)) / n;
    if (mode === 'page') {
      const p = pages[Math.min(store.current, pages.length - 1)];
      const { w, h } = store.tool === 'crop' ? shownSize(p) : visibleSize(p);
      // Room for the page number under each page.
      const availH = this.scroller.clientHeight - 40 - (n > 1 ? 20 : 0);
      this.setZoom(Math.max(0.2, Math.min(availW / (w * PT_TO_PX), availH / (h * PT_TO_PX))), 'page');
      return;
    }
    const widest = Math.max(...pages.map((p) => (store.tool === 'crop' ? shownSize(p) : visibleSize(p)).w)) * PT_TO_PX;
    // Fill the width on small screens, but stop at a comfortable reading size on wide ones.
    this.setZoom(Math.max(0.25, Math.min(n > 1 ? 1.5 : 1.25, availW / widest)), 'width');
  }

  // ---------- painting ----------

  private onVisibility(list: IntersectionObserverEntry[]): void {
    for (const e of list) {
      const c = this.cards.get((e.target as HTMLElement).dataset.key!);
      if (!c) continue;
      c.visible = e.isIntersecting;
      if (c.visible) {
        this.paint(c);
        this.renderFields(c);
      } else cancelRender(`v:${c.key}`);
    }
  }

  private paint(c: Card): void {
    const target = fitScale(c.entry, this.k * dpr());
    const key = bitmapKey(c.entry);
    if (c.bmpKey !== key || Math.abs(c.bmpScale - target) / target > 0.05) {
      const near = this.scroller.getBoundingClientRect();
      const r = c.wrap.getBoundingClientRect();
      const entry = c.entry;
      requestRender({
        id: `v:${c.key}`,
        page: entry,
        scale: target,
        priority: Math.abs(r.top + r.height / 2 - (near.top + near.height / 2)),
        done: (img, scale) => {
          if (!img || this.cards.get(c.key) !== c) return;
          c.pdf.width = img.width;
          c.pdf.height = img.height;
          c.pdf.getContext('2d')!.putImageData(img, 0, 0);
          c.bmpKey = bitmapKey(entry);
          c.bmpScale = scale;
        },
      });
    }
    this.paintInk(c);
    c.forms?.show();
  }

  private repaintAll(): void {
    for (const c of this.cards.values()) if (c.visible) this.paintInk(c);
  }

  paintInk(c: Card, force = false): void {
    const scale = fitScale(c.entry, this.k * dpr());
    const plan = store.plan;
    const idx = this.entries().indexOf(c.entry);
    const keyParts = [c.entry, scale, plan.hf, plan.wm, idx, this.entries().length, c.hide.size, c.override.size, store.tool === 'redact'];
    if (!force && c.inkKey && keyParts.every((v, i) => v === c.inkKey![i])) return;
    c.inkKey = keyParts;
    const { w, h } = shownSize(c.entry);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    if (c.ink.width !== cw || c.ink.height !== ch) {
      c.ink.width = cw;
      c.ink.height = ch;
    }
    const ctx = c.ink.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(...pageMatrix(c.entry, scale));
    const items = c.override.size ? c.entry.items.map((it) => c.override.get(it.id) ?? it) : c.entry.items;
    drawItems(ctx, items, { hide: c.hide, aids: true });
    if (this.isMain() && (plan.hf || plan.wm)) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawDecor(ctx, c.entry, idx + 1, this.entries().length, baseName(), plan.hf, plan.wm, w, h);
    }
  }

  private refreshBitmap(src: string): void {
    for (const c of this.cards.values()) {
      if (c.entry.src === src) {
        c.bmpKey = '';
        if (c.visible) this.paint(c);
      }
    }
  }

  // ---------- detected form boxes ----------

  private fieldsActive(): boolean {
    return !!store.doc?.fieldsOn && (store.tool === 'hand' || store.tool === 'select' || store.tool === 'text' || store.tool === 'mark');
  }

  private renderAllFields(): void {
    for (const c of this.cards.values()) this.renderFields(c);
  }

  private renderFields(c: Card): void {
    const fields = store.fieldsFor(c.entry);
    c.fieldsEl.classList.toggle('active', this.fieldsActive());
    if (!fields.length || !c.visible) {
      if (c.fieldsEl.childElementCount && !fields.length) c.fieldsEl.textContent = '';
      return;
    }
    const filled = new Set(c.entry.items.filter((it) => (it.type === 'text' || it.type === 'mark') && it.field).map((it) => (it as TextItem | MarkItem).field!));
    const html = fields
      .map((f) => {
        const r = rectToScreen(c.entry, f);
        const k = this.k;
        return `<button type="button" class="hot hot-${f.kind}${filled.has(f.id) ? ' filled' : ''}" data-f="${f.id}" title="${(f.label || '').replace(/"/g, '&quot;')}${f.option ? ` · ${f.option.replace(/"/g, '&quot;')}` : ''}" style="left:${r.x * k}px;top:${r.y * k}px;width:${r.w * k}px;height:${r.h * k}px"></button>`;
      })
      .join('');
    c.fieldsEl.innerHTML = html;
  }

  private onFieldClick(c: Card, e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest('.hot') as HTMLElement | null;
    if (!el) return;
    e.stopPropagation();
    const f = store.fieldsFor(c.entry).find((x) => x.id === el.dataset.f);
    if (f) this.activateField(c, f);
  }

  private activateField(c: Card, f: DetectedField): void {
    if (f.kind === 'text') {
      const existing = c.entry.items.find((it): it is TextItem => it.type === 'text' && it.field === f.id);
      if (existing) {
        this.startEdit(c, existing, false);
        return;
      }
      const item: TextItem = {
        id: uid('t'),
        type: 'text',
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        rot: 0,
        text: '',
        font: f.font,
        size: f.size,
        bold: false,
        italic: false,
        color: store.prefs.textColor,
        valign: f.multiline ? 'top' : 'middle',
        wrap: f.multiline,
        field: f.id,
        cover: f.cover,
      };
      this.startEdit(c, item, true);
      return;
    }
    // Tick boxes toggle. Radio buttons on one row clear each other.
    const mine = c.entry.items.find((it) => it.type === 'mark' && it.field === f.id);
    const fields = store.fieldsFor(c.entry);
    const group = f.group ? new Set(fields.filter((x) => x.group === f.group).map((x) => x.id)) : new Set([f.id]);
    store.updatePage(c.key, (p) => {
      const items = p.items.filter((it) => !(it.type === 'mark' && it.field && group.has(it.field)));
      if (!mine) {
        const shape = f.kind === 'radio' ? 'dot' : store.prefs.markShape === 'dot' ? 'check' : store.prefs.markShape;
        items.push({ id: uid('m'), type: 'mark', x: f.x, y: f.y, w: f.w, h: f.h, shape, color: store.prefs.textColor, field: f.id });
      }
      return { ...p, items };
    });
  }

  /** Opens the next (or previous) text box in reading order, across pages. */
  private gotoField(fromKey: string, fromField: string, dir: 1 | -1): void {
    const order: { key: string; f: DetectedField }[] = [];
    for (const p of store.pages) for (const f of store.fieldsFor(p)) if (f.kind === 'text') order.push({ key: p.key, f });
    const at = order.findIndex((o) => o.key === fromKey && o.f.id === fromField);
    const next = order[at + dir];
    if (!next) return;
    const c = this.cards.get(next.key);
    if (!c) return;
    const i = store.pages.findIndex((p) => p.key === next.key);
    const r = rectToScreen(c.entry, next.f);
    const top = c.wrap.offsetTop + r.y * this.k - this.scroller.clientHeight / 3;
    if (Math.abs(this.scroller.scrollTop - top) > this.scroller.clientHeight / 3) this.scroller.scrollTo({ top });
    store.setCurrent(i);
    this.activateField(c, next.f);
  }

  // ---------- text editing ----------

  startEdit(c: Card, item: TextItem, isNew: boolean): void {
    this.finishEdit(true);
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    spelling(ta);
    ta.value = item.text;
    c.paper.append(ta);
    editing = { card: c, item, isNew, ta, viewer: this };
    c.hide.add(item.id);
    this.paintInk(c, true);
    this.placeEditor();
    store.setEditing({ key: c.key, id: item.id });
    store.select({ key: c.key, id: item.id });
    ta.addEventListener('input', () => {
      if (!editing) return;
      editing.item = fitText({ ...editing.item, text: ta.value });
      this.placeEditor();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (!editing) return;
      const ed = editing;
      if (e.key === 'Escape') {
        // Esc means "done": what was typed is kept (Undo removes it).
        e.preventDefault();
        this.finishEdit(true);
      } else if (e.key === 'Tab' && ed.item.field) {
        e.preventDefault();
        const key = ed.card.key;
        const fid = ed.item.field;
        this.finishEdit(true);
        this.gotoField(key, fid, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Enter' && ed.item.field && !ed.item.wrap) {
        e.preventDefault();
        const key = ed.card.key;
        const fid = ed.item.field;
        this.finishEdit(true);
        this.gotoField(key, fid, 1);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.finishEdit(true);
      }
    });
    ta.addEventListener('blur', () => {
      // Clicks on the text toolbar keep the editor open.
      setTimeout(() => {
        if (editing?.ta === ta && !document.activeElement?.closest('.ctxbar')) this.finishEdit(true);
      }, 0);
    });
    // Focus right away: keys typed straight after Tab must land in the box,
    // not in the tool shortcuts.
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Edit text: turns the line of PDF text under (x, y) into an editable box that looks the same. */
  private retypeAt(c: Card, x: number, y: number): void {
    if (c.entry.src === null) {
      toast('This page was added in Nib-E and has no text of its own. Use Add text.');
      return;
    }
    let line;
    try {
      line = lineAt(c.entry, x, y);
    } catch (e) {
      console.warn(e);
      line = null;
    }
    if (!line) {
      toast(pageChars(c.entry).length ? 'No text right here. Click on a line of text.' : 'This page has no text to edit (it may be a scan or a picture).');
      return;
    }
    if (line.problem) {
      toast(line.problem, 'info', 6000);
      return;
    }
    const size = line.size;
    const padX = Math.max(1.5, size * 0.18);
    const first = line.chars[0];
    const hide = { x: line.x0, y: line.top, w: line.x1 - line.x0, h: line.bottom - line.top };
    const item: TextItem = {
      id: uid('rt'),
      type: 'text',
      x: line.x0 - padX,
      y: line.baseline - size * 1.07,
      w: line.x1 - line.x0 + padX * 2,
      h: size * 1.4,
      rot: 0,
      text: line.text,
      font: line.font,
      size,
      bold: line.bold,
      italic: line.italic,
      color: line.color,
      valign: 'top',
      wrap: false,
      align: line.align,
      replace: {
        area: removalArea(line),
        hide,
        orig: line.text,
        glyphs: line.glyphs,
        pdfFont: line.pdfFont,
        font0: { font: line.font, size, bold: line.bold, italic: line.italic },
        probe: [(first.x0 + first.x1) / 2, (first.y0 + first.y1) / 2],
        bg: lineBackground(c.entry, hide),
      },
    };
    this.startEdit(c, item, true);
    if (line.fontData) {
      void previewFont(line.fontData, line.pdfFont).then((css) => {
        if (!css) return;
        const patch = (t: TextItem): TextItem => ({ ...t, replace: t.replace ? { ...t.replace, css } : t.replace });
        if (editing?.item.id === item.id) {
          editing.item = patch(editing.item);
          this.placeEditor();
        } else {
          const hit = store.findItem(c.key, item.id);
          if (hit?.type === 'text') store.replaceItem(c.key, patch(hit));
        }
      });
    }
  }

  restyleEdit(patch: Partial<TextItem>): void {
    if (!editing) return;
    editing.item = fitText({ ...editing.item, ...patch });
    this.placeEditor();
    editing.ta.focus();
  }

  private placeEditor(): void {
    if (!editing || editing.viewer !== this) return;
    const { item, ta, card } = editing;
    const k = this.k;
    const r = rectToScreen(card.entry, item);
    const lay = layoutText(item);
    // The box is typed in the direction its text runs on screen: on a turned
    // page (or for turned text) the editor is turned with it.
    const turn = (totalRot(card.entry) + item.rot) % 4;
    const cs = contentSize(item);
    const w = Math.max(cs.w, item.size * 2) * k;
    const h = Math.max(cs.h, lay.needH) * k;
    const cx = (r.x + r.w / 2) * k;
    const cy = (r.y + r.h / 2) * k;
    Object.assign(ta.style, {
      left: turn ? `${cx - w / 2}px` : `${r.x * k}px`,
      top: turn ? `${cy - h / 2}px` : `${r.y * k}px`,
      width: `${w}px`,
      height: `${h}px`,
      transform: turn ? `rotate(${turn * 90}deg)` : '',
      transformOrigin: 'center',
      font: textCss(item, item.size * k),
      textAlign: item.align ?? 'left',
      lineHeight: `${lay.lineH * k}px`,
      color: item.color,
      paddingLeft: `${lay.padX * k}px`,
      paddingRight: `${lay.padX * k}px`,
      paddingTop: `${Math.max(0, lay.base - lay.lineH / 2 - item.size * 0.36) * k}px`,
      whiteSpace: item.wrap ? 'pre-wrap' : 'pre',
      background: item.cover ? '#ffffff' : item.replace ? item.replace.bg : 'transparent',
    });
  }

  /** Ends editing. commit=false throws away changes (and the box, if new). */
  finishEdit(commit: boolean): void {
    if (!editing || editing.viewer !== this) return;
    const ed = editing;
    editing = null;
    ed.ta.remove();
    ed.card.hide.delete(ed.item.id);
    store.setEditing(null);
    const text = ed.item.text.replace(/\s+$/, '');
    if (commit && ed.item.replace) {
      // Edited PDF text: an unchanged new line is no edit; an emptied line removes the original.
      const item = { ...ed.item, text };
      if (ed.isNew && text === ed.item.replace.orig) {
        this.paintInk(ed.card, true);
        store.select(null);
      } else if (ed.isNew) {
        store.addItems(ed.card.key, [item]);
        if (!text.trim()) toast('Line removed. Undo brings it back.', 'ok');
        else if (!retypeTold) {
          retypeTold = true;
          toast("Text changed. Saving removes the old words and writes the new ones in the PDF's own font where it can.", 'ok', 6000);
        }
      } else {
        const old = store.findItem(ed.card.key, item.id);
        if (JSON.stringify(old) !== JSON.stringify(item)) store.replaceItem(ed.card.key, item);
        else this.paintInk(ed.card, true);
      }
      this.renderFields(ed.card);
      return;
    }
    if (commit) {
      const item = { ...ed.item, text };
      if (!text.trim()) {
        if (!ed.isNew) store.removeItems(ed.card.key, new Set([item.id]));
        else this.paintInk(ed.card, true);
        store.select(null);
      } else if (ed.isNew) store.addItems(ed.card.key, [item]);
      else {
        const old = store.findItem(ed.card.key, item.id);
        if (JSON.stringify(old) !== JSON.stringify(item)) store.replaceItem(ed.card.key, item);
        else this.paintInk(ed.card, true);
      }
      store.setPrefs({ textFont: item.font, textSize: item.size, textBold: item.bold, textItalic: item.italic, textColor: item.color });
    } else {
      this.paintInk(ed.card, true);
    }
    this.renderFields(ed.card);
  }

  // ---------- notes ----------

  private openNote(c: Card, note: NoteItem, isNew: boolean): void {
    this.closeNote();
    const pop = document.createElement('div');
    pop.className = 'note-pop';
    pop.innerHTML = `<textarea placeholder="Write a note" aria-label="Note text"></textarea><div class="note-actions"><button type="button" class="btn btn-quiet" data-a="del">Delete</button><span class="grow"></span><button type="button" class="btn btn-primary" data-a="ok">Done</button></div>`;
    const ta = pop.querySelector('textarea')!;
    spelling(ta);
    ta.value = note.text;
    const b = rectToScreen(c.entry, itemBounds(note));
    pop.style.left = `${(b.x + b.w) * this.k + 6}px`;
    pop.style.top = `${b.y * this.k}px`;
    c.paper.append(pop);
    this.notePop = pop;
    const done = (keep: boolean) => {
      this.closeNote();
      const text = ta.value.trim();
      if (!keep || !text) {
        if (!isNew) store.removeItems(c.key, new Set([note.id]));
        return;
      }
      if (isNew) store.addItems(c.key, [{ ...note, text }]);
      else if (text !== note.text) store.replaceItem(c.key, { ...note, text });
    };
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.querySelector('[data-a="ok"]')!.addEventListener('click', () => done(true));
    pop.querySelector('[data-a="del"]')!.addEventListener('click', () => done(false));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(!isNew);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true);
    });
    requestAnimationFrame(() => ta.focus());
  }

  private closeNote(): void {
    this.notePop?.remove();
    this.notePop = null;
  }

  // ---------- selection ----------

  private renderSelection(): void {
    const sel = store.sel;
    const c = sel ? this.cards.get(sel.key) : undefined;
    const item = sel && c ? c.entry.items.find((it) => it.id === sel.id) : undefined;
    if (!c || !item || (editing && editing.item.id === item.id)) {
      this.selBox.remove();
      return;
    }
    const b = rectToScreen(c.entry, itemBounds(c.override.get(item.id) ?? item));
    const k = this.k;
    const pad = 3;
    Object.assign(this.selBox.style, { left: `${b.x * k - pad}px`, top: `${b.y * k - pad}px`, width: `${b.w * k + pad * 2}px`, height: `${b.h * k + pad * 2}px` });
    this.selBox.classList.toggle('resizable', item.type !== 'note' && item.type !== 'markup');
    if (this.selBox.parentElement !== c.paper) c.paper.append(this.selBox);
  }

  private hitItem(c: Card, x: number, y: number): Item | null {
    const tol = 4 / this.k;
    for (let i = c.entry.items.length - 1; i >= 0; i--) {
      const it = c.entry.items[i];
      if (it.type === 'ink') {
        if (inkHits(it, x, y, tol + 2)) return it;
        continue;
      }
      if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
        if (segmentHits(it.x1, it.y1, it.x2, it.y2, x, y, tol + it.width + 2)) return it;
        continue;
      }
      if (it.type === 'markup') {
        if (it.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return it;
        continue;
      }
      const b = itemBounds(it);
      if (x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol) return it;
    }
    return null;
  }

  private onSelDown(e: PointerEvent): void {
    const sel = store.sel;
    if (!sel || (e.button !== 0 && e.pointerType === 'mouse')) return;
    const c = this.cards.get(sel.key);
    const item = c?.entry.items.find((it) => it.id === sel.id);
    if (!c || !item) return;
    e.preventDefault();
    e.stopPropagation();
    this.pagesEl.setPointerCapture(e.pointerId);
    const [x, y] = this.pagePoint(c, e);
    const handle = (e.target as HTMLElement).dataset.h;
    if (handle) {
      // Handles are placed in screen orientation; convert the drag through the page.
      this.session = { kind: 'resize', id: e.pointerId, card: c, item, handle, start: rectToScreen(c.entry, itemBounds(item)), x0: e.clientX, y0: e.clientY };
    } else {
      this.session = { kind: 'move', id: e.pointerId, card: c, item, x0: x, y0: y, moved: false };
    }
  }

  private onDouble(e: MouseEvent): void {
    if (store.tool !== 'select' && store.tool !== 'text' && store.tool !== 'retype') return;
    const c = this.cardAt(e.target);
    if (!c) return;
    const [x, y] = this.pagePoint(c, e);
    const it = this.hitItem(c, x, y);
    if (it?.type === 'text') this.startEdit(c, it, false);
    else if (it?.type === 'note') this.openNote(c, it, false);
  }

  // ---------- navigation ----------

  scrollToPage(i: number, smooth = true): void {
    const p = this.entries()[i];
    const c = p && this.cards.get(p.key);
    if (!c) return;
    // Hold the chosen page as current while the scroll settles.
    this.pinnedUntil = performance.now() + 700;
    this.scroller.scrollTo({ top: c.wrap.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    if (this.isMain()) store.setCurrent(i);
  }

  scrollToEnd(): void {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: 'smooth' });
  }

  private onScroll(): void {
    if (!this.isMain()) return;
    const now = performance.now();
    if (now < this.pinnedUntil) {
      this.pinnedUntil = Math.max(this.pinnedUntil, now + 150);
      return;
    }
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
      let best = 0;
      this.entries().forEach((p, i) => {
        const c = this.cards.get(p.key);
        if (c && c.wrap.offsetTop <= mid) best = i;
      });
      store.setCurrent(best);
    });
  }

  zoomAt(clientX: number, clientY: number, z: number): void {
    const r = this.scroller.getBoundingClientRect();
    const ox = clientX - r.left;
    const oy = clientY - r.top;
    const cx = this.scroller.scrollLeft + ox;
    const cy = this.scroller.scrollTop + oy;
    const before = this.zoom;
    this.setZoom(z);
    const ratio = this.zoom / before;
    this.scroller.scrollLeft = cx * ratio - ox;
    this.scroller.scrollTop = cy * ratio - oy;
  }

  zoomBy(factor: number): void {
    const r = this.scroller.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 3, this.zoom * factor);
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 40 ? 0.01 : 0.0018));
    this.zoomAt(e.clientX, e.clientY, this.zoom * factor);
  }

  // ---------- input ----------

  private cropShown = false;

  private applyTool(): void {
    const t = store.tool;
    this.pagesEl.dataset.tool = t;
    if ((t === 'crop') !== this.cropShown) {
      this.cropShown = t === 'crop';
      for (const c of this.cards.values()) this.size(c);
      this.renderSelection();
    }
    const scrolls = t === 'hand' || t === 'select' || t === 'text';
    this.pagesEl.style.touchAction = scrolls ? 'pan-x pan-y' : 'none';
    for (const c of this.cards.values()) {
      c.forms?.setActive(FIELD_TOOLS.has(t));
      c.fieldsEl.classList.toggle('active', this.fieldsActive());
      if (c.visible) this.paintInk(c);
    }
    if (t !== 'text' && t !== 'select' && editing?.viewer === this) this.finishEdit(true);
    if (t !== 'select') this.clearTextSelection();
  }

  private cardAt(target: EventTarget | null): Card | null {
    const el = (target as HTMLElement | null)?.closest?.('.sheet') as HTMLElement | null;
    return el ? this.cards.get(el.dataset.key!) ?? null : null;
  }

  private pagePoint(c: Card, e: { clientX: number; clientY: number }): [number, number] {
    const r = c.paper.getBoundingClientRect();
    return toPage(c.entry, (e.clientX - r.left) / this.k, (e.clientY - r.top) / this.k);
  }

  private fingersScroll(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && !store.prefs.fingerDraws;
  }

  private onDown(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('.hot, .sel-box, .text-editor, .note-pop, .field, .field-input')) return;
    if (e.pointerType === 'pen' && !store.penSeen) {
      store.penSeen = true;
      if (store.prefs.fingerDraws) {
        store.setPrefs({ fingerDraws: false });
        toast('Pen detected. Your fingers now scroll, so your palm will not leave marks.');
      }
    }
    const tool = store.tool;
    this.closeNote();

    if (e.pointerType === 'touch' && tool !== 'hand' && tool !== 'select' && tool !== 'text') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // A second finger always means pinch: drop whatever the first finger began.
        this.abortSession();
        const [a, b] = [...this.touches.values()];
        this.cancelHold();
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        return;
      }
      if (this.fingersScroll(e)) return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.pointerType === 'touch' && (tool === 'hand' || tool === 'select' || tool === 'text' || tool === 'retype')) this.startHold(e);
    if (this.session) return;

    if (tool === 'hand') {
      if (e.pointerType === 'mouse' && !(e.target as HTMLElement).closest('.field')) {
        this.session = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY };
        this.pagesEl.setPointerCapture(e.pointerId);
        this.pagesEl.classList.add('dragging');
      }
      return;
    }

    const c = this.cardAt(e.target);
    if (!c) {
      if (tool === 'select') store.select(null);
      return;
    }
    const [x, y] = this.pagePoint(c, e);

    if (tool === 'retype') {
      const hit = this.hitItem(c, x, y);
      if (hit?.type === 'text') {
        e.preventDefault();
        this.startEdit(c, hit, false);
        return;
      }
      this.session = { kind: 'tap', id: e.pointerId, card: c, tool, x, y, cx: e.clientX, cy: e.clientY };
      return;
    }
    if (tool === 'select' || tool === 'text') {
      const hit = this.hitItem(c, x, y);
      if (tool === 'text' && hit?.type === 'text') {
        e.preventDefault();
        this.startEdit(c, hit, false);
        return;
      }
      if (tool === 'select') {
        if (hit) {
          e.preventDefault();
          this.clearTextSelection();
          store.select({ key: c.key, id: hit.id });
          this.pagesEl.setPointerCapture(e.pointerId);
          this.session = { kind: 'move', id: e.pointerId, card: c, item: hit, x0: x, y0: y, moved: false };
        } else {
          store.select(null);
          // The PDF's own text: drag to select, double-click a word, triple-click a line.
          if (e.pointerType !== 'touch') this.startTextSelection(c, e, x, y);
        }
        return;
      }
      // Text tool on empty space: tap to create (a drag scrolls on touch).
      this.session = { kind: 'tap', id: e.pointerId, card: c, tool, x, y, cx: e.clientX, cy: e.clientY };
      return;
    }

    e.preventDefault();
    this.pagesEl.setPointerCapture(e.pointerId);
    const penEraser = e.pointerType === 'pen' && (e.buttons & 32) !== 0;
    if (tool === 'eraser' || penEraser) {
      this.session = { kind: 'erase', id: e.pointerId, card: c, erased: new Set() };
      this.eraseAt(c, x, y);
      return;
    }
    if (tool === 'pen' || tool === 'highlighter') {
      this.startInk(c, e, tool);
      return;
    }
    if (tool === 'markup') {
      const chars = pageChars(c.entry).filter((ch) => !/\s/.test(ch.ch) || ch.x1 > ch.x0);
      if (!chars.length) {
        toast(c.entry.src === null ? 'This page has no text to mark. Use the highlighter instead.' : 'No selectable text on this page (it may be a scan).');
        return;
      }
      const at = this.nearestChar(chars, x, y);
      this.session = { kind: 'markup', id: e.pointerId, card: c, chars, from: at, to: at, raf: 0 };
      return;
    }
    if (tool === 'shape' || tool === 'link' || tool === 'redact' || tool === 'field' || tool === 'crop') {
      const band = document.createElement('div');
      band.className = `band band-${tool}`;
      c.paper.append(band);
      this.session = { kind: 'rect', id: e.pointerId, card: c, tool, x0: x, y0: y, x1: x, y1: y, band };
      this.updateBand();
      return;
    }
    this.session = { kind: 'tap', id: e.pointerId, card: c, tool, x, y, cx: e.clientX, cy: e.clientY };
  }

  private startInk(c: Card, e: PointerEvent, tool: 'pen' | 'highlighter'): void {
    const pen = e.pointerType === 'pen' && e.pressure > 0;
    const sim = !pen;
    const smooth = new Smoother(pen, store.prefs.penFeel);
    const scale = fitScale(c.entry, this.k * dpr());
    const live = c.live ?? document.createElement('canvas');
    if (!c.live) {
      live.className = 'layer-live';
      c.paper.append(live);
      c.live = live;
    }
    const { w, h } = shownSize(c.entry);
    live.width = Math.round(w * scale);
    live.height = Math.round(h * scale);
    const [sx, sy, sp] = smooth.push(e.clientX, e.clientY, sim ? 0.5 : e.pressure, e.timeStamp);
    const [x, y] = this.pagePoint(c, { clientX: sx, clientY: sy });
    this.session = {
      kind: 'ink',
      id: e.pointerId,
      card: c,
      pts: [[x, y, sp]],
      sim,
      smooth,
      feel: store.prefs.penFeel,
      tool,
      color: tool === 'pen' ? store.prefs.penColor : store.prefs.hlColor,
      size: tool === 'pen' ? store.prefs.penSize : store.prefs.hlSize,
      scale,
      raf: 0,
    };
    this.queueLive();
  }

  private startHold(e: PointerEvent): void {
    this.cancelHold();
    const x = e.clientX;
    const y = e.clientY;
    const target = e.target;
    this.hold = {
      x,
      y,
      id: e.pointerId,
      timer: window.setTimeout(() => {
        this.hold = null;
        const c = this.cardAt(target);
        if (!c) return;
        const [px, py] = this.pagePoint(c, { clientX: x, clientY: y });
        const hit = this.hitItem(c, px, py);
        if (!hit) return;
        this.session = null;
        if (store.tool !== 'select') store.setTool('select');
        store.select({ key: c.key, id: hit.id });
        navigator.vibrate?.(12);
      }, 550),
    };
  }

  private cancelHold(): void {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = null;
  }

  private onMove(e: PointerEvent): void {
    if (this.hold && this.hold.id === e.pointerId && Math.hypot(e.clientX - this.hold.x, e.clientY - this.hold.y) > 10) this.cancelHold();
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const prevPt = this.touches.get(e.pointerId)!;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.zoomAt(mx, my, this.pinch.zoom * (d / this.pinch.dist));
        // Two fingers also move the page, so one finger can keep writing.
        this.scroller.scrollBy(this.pinch.mx - mx, this.pinch.my - my);
        this.pinch.mx = mx;
        this.pinch.my = my;
        return;
      }
      if (this.fingersScroll(e) && this.touches.size === 1) {
        this.scroller.scrollBy(prevPt.x - e.clientX, prevPt.y - e.clientY);
        return;
      }
    }
    const s = this.session;
    if (!s || s.id !== e.pointerId) return;
    switch (s.kind) {
      case 'pan':
        this.scroller.scrollBy(s.x - e.clientX, s.y - e.clientY);
        s.x = e.clientX;
        s.y = e.clientY;
        return;
      case 'erase':
        for (const ev of e.getCoalescedEvents?.() ?? [e]) {
          const [x, y] = this.pagePoint(s.card, ev);
          this.eraseAt(s.card, x, y);
        }
        return;
      case 'ink': {
        for (const ev of e.getCoalescedEvents?.() ?? [e]) {
          const [fx, fy, fp] = s.smooth.push(ev.clientX, ev.clientY, s.sim ? 0.5 : ev.pressure || 0.5, ev.timeStamp);
          const [x, y] = this.pagePoint(s.card, { clientX: fx, clientY: fy });
          const last = s.pts[s.pts.length - 1];
          // Skip sub-pixel steps: they only add noise.
          if (Math.hypot(x - last[0], y - last[1]) * this.k < 0.6) continue;
          s.pts.push([x, y, fp]);
        }
        this.queueLive();
        return;
      }
      case 'move': {
        const [x, y] = this.pagePoint(s.card, e);
        const dx = x - s.x0;
        const dy = y - s.y0;
        if (!s.moved && Math.hypot(dx, dy) * this.k < 3) return;
        s.moved = true;
        s.card.override.set(s.item.id, moveItem(s.item, dx, dy));
        this.paintInk(s.card);
        this.renderSelection();
        return;
      }
      case 'resize': {
        const k = this.k;
        const dx = (e.clientX - s.x0) / k;
        const dy = (e.clientY - s.y0) / k;
        const r = { ...s.start };
        if (s.handle.includes('w')) {
          r.x += dx;
          r.w -= dx;
        }
        if (s.handle.includes('e')) r.w += dx;
        if (s.handle.includes('n')) {
          r.y += dy;
          r.h -= dy;
        }
        if (s.handle.includes('s')) r.h += dy;
        if (r.w < 4 || r.h < 4) return;
        const keepRatio = s.item.type === 'image' || s.item.type === 'stamp' || s.item.type === 'mark' || e.shiftKey;
        if (keepRatio) {
          const ratio = s.start.w / s.start.h;
          if (r.w / r.h > ratio) r.w = r.h * ratio;
          else r.h = r.w / ratio;
          if (s.handle.includes('w')) r.x = s.start.x + s.start.w - r.w;
          if (s.handle.includes('n')) r.y = s.start.y + s.start.h - r.h;
        }
        s.card.override.set(s.item.id, this.resized(s.card.entry, s.item, rectToPage(s.card.entry, r)));
        this.paintInk(s.card);
        this.renderSelection();
        return;
      }
      case 'rect': {
        const [x, y] = this.pagePoint(s.card, e);
        s.x1 = x;
        s.y1 = y;
        this.updateBand();
        return;
      }
      case 'markup': {
        const [x, y] = this.pagePoint(s.card, e);
        s.to = this.nearestChar(s.chars, x, y);
        if (!s.raf) s.raf = requestAnimationFrame(() => this.drawMarkupPreview());
        return;
      }
      case 'textsel': {
        if (!s.moved && Math.hypot(e.clientX - s.cx, e.clientY - s.cy) < 4) return;
        s.moved = true;
        if (!s.chars.length) return;
        const [x, y] = this.pagePoint(s.card, e);
        s.to = this.nearestChar(s.chars, x, y);
        this.textSel = { card: s.card, chars: s.chars, from: s.from, to: s.to };
        this.renderTextSelection(false);
        return;
      }
      case 'tap':
        if (Math.hypot(e.clientX - s.cx, e.clientY - s.cy) > 10) this.session = null;
        return;
    }
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (this.hold?.id === e.pointerId) this.cancelHold();
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    }
    const s = this.session;
    if (!s || s.id !== e.pointerId) return;
    this.session = null;
    try {
      this.pagesEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    switch (s.kind) {
      case 'pan':
        this.pagesEl.classList.remove('dragging');
        return;
      case 'erase':
        s.card.hide.clear();
        if (s.erased.size && !cancelled) store.removeItems(s.card.key, s.erased);
        else this.paintInk(s.card, true);
        return;
      case 'ink': {
        cancelAnimationFrame(s.raf);
        this.clearLive(s.card);
        if (cancelled && e.pointerType === 'touch') return;
        // End exactly where the pen lifted (the filter lags slightly).
        const [ex, ey] = this.pagePoint(s.card, e);
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(ex - last[0], ey - last[1]) * this.k > 0.6) s.pts.push([ex, ey, last[2]]);
        const pts = s.pts.length === 1 ? [s.pts[0], [s.pts[0][0] + 0.01, s.pts[0][1] + 0.01, s.pts[0][2]] as Pt] : s.pts;
        const item: InkItem = { id: uid('s'), type: 'ink', kind: s.tool, color: s.color, size: s.size, sim: s.sim, pts, feel: s.feel };
        store.addItems(s.card.key, [item]);
        return;
      }
      case 'move': {
        const moved = s.card.override.get(s.item.id);
        s.card.override.clear();
        if (s.moved && moved && !cancelled) store.replaceItem(s.card.key, moved);
        else this.paintInk(s.card, true);
        this.renderSelection();
        return;
      }
      case 'resize': {
        const next = s.card.override.get(s.item.id);
        s.card.override.clear();
        if (next && !cancelled) store.replaceItem(s.card.key, next);
        else this.paintInk(s.card, true);
        this.renderSelection();
        return;
      }
      case 'rect':
        s.band.remove();
        if (!cancelled) this.finishRect(s);
        return;
      case 'markup':
        cancelAnimationFrame(s.raf);
        this.clearLive(s.card);
        if (!cancelled) this.finishMarkup(s);
        return;
      case 'textsel':
        if (cancelled) return;
        if (!s.chars.length) {
          if (s.moved) toast(s.card.entry.src === null ? 'This page has no text of its own.' : 'No selectable text on this page. For a scan, use Toolbox → Text recognition first.');
          return;
        }
        if (!s.moved && s.clicks < 2) {
          this.clearTextSelection();
          return;
        }
        this.renderTextSelection(true);
        return;
      case 'tap':
        if (!cancelled) void this.tap(s.card, s.tool, s.x, s.y);
        return;
    }
  }

  private abortSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (s.kind === 'ink') {
      cancelAnimationFrame(s.raf);
      this.clearLive(s.card);
    } else if (s.kind === 'erase') {
      s.card.hide.clear();
      this.paintInk(s.card, true);
    } else if (s.kind === 'rect') s.band.remove();
    else if (s.kind === 'markup') this.clearLive(s.card);
  }

  // ---------- tool actions ----------

  private queueLive(): void {
    const s = this.session;
    if (!s || s.kind !== 'ink' || s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      const live = s.card.live;
      if (!live) return;
      const ctx = live.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, live.width, live.height);
      ctx.setTransform(...pageMatrix(s.card.entry, s.scale));
      drawLive(ctx, { kind: s.tool, size: s.size, sim: s.sim, color: s.color, pts: s.pts, feel: s.feel });
    });
  }

  private clearLive(c: Card): void {
    if (!c.live) return;
    c.live.getContext('2d')!.clearRect(0, 0, c.live.width, c.live.height);
  }

  private eraseAt(c: Card, x: number, y: number): void {
    const s = this.session;
    if (!s || s.kind !== 'erase') return;
    const r = 9 / this.k;
    let changed = false;
    for (const it of c.entry.items) {
      if (c.hide.has(it.id)) continue;
      let hit = false;
      if (it.type === 'ink') hit = inkHits(it, x, y, r);
      else if (it.type === 'shape') {
        const b = itemBounds(it);
        hit = it.shape === 'line' || it.shape === 'arrow' ? segmentHits(it.x1, it.y1, it.x2, it.y2, x, y, r + it.width) : x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
      } else if (it.type === 'markup') hit = it.rects.some((q) => x >= q.x - r && x <= q.x + q.w + r && y >= q.y - r && y <= q.y + q.h + r);
      else if (it.type === 'mark') hit = x >= it.x - r && x <= it.x + it.w + r && y >= it.y - r && y <= it.y + it.h + r;
      if (hit) {
        c.hide.add(it.id);
        s.erased.add(it.id);
        changed = true;
      }
    }
    if (changed) this.paintInk(c, true);
  }

  private updateBand(): void {
    const s = this.session;
    if (!s || s.kind !== 'rect') return;
    const k = this.k;
    const isLine = s.tool === 'shape' && (store.prefs.shape === 'line' || store.prefs.shape === 'arrow');
    const r = rectToScreen(s.card.entry, { x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1), w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) });
    Object.assign(s.band.style, { left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.w * k}px`, height: `${r.h * k}px` });
    s.band.classList.toggle('band-line', isLine);
    if (s.tool === 'shape') {
      const sh: ShapeItem = { id: '__preview', type: 'shape', shape: store.prefs.shape, x1: s.x0, y1: s.y0, x2: s.x1, y2: s.y1, color: store.prefs.shapeColor, width: store.prefs.shapeWidth };
      s.card.override.clear();
      const live = this.ensureLive(s.card);
      const ctx = live.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, live.width, live.height);
      ctx.setTransform(...pageMatrix(s.card.entry, fitScale(s.card.entry, this.k * dpr())));
      drawItems(ctx, [sh]);
      s.band.style.visibility = 'hidden';
    }
  }

  private ensureLive(c: Card): HTMLCanvasElement {
    const scale = fitScale(c.entry, this.k * dpr());
    const live = c.live ?? document.createElement('canvas');
    if (!c.live) {
      live.className = 'layer-live';
      c.paper.append(live);
      c.live = live;
    }
    const { w, h } = shownSize(c.entry);
    const W = Math.round(w * scale);
    const H = Math.round(h * scale);
    if (live.width !== W || live.height !== H) {
      live.width = W;
      live.height = H;
    }
    return live;
  }

  private finishRect(s: Extract<Session, { kind: 'rect' }>): void {
    const c = s.card;
    this.clearLive(c);
    const r = { x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1), w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) };
    const tiny = r.w * this.k < 6 && r.h * this.k < 6;
    if (s.tool === 'shape') {
      if (tiny) return;
      const it: ShapeItem = { id: uid('sh'), type: 'shape', shape: store.prefs.shape, x1: s.x0, y1: s.y0, x2: s.x1, y2: s.y1, color: store.prefs.shapeColor, width: store.prefs.shapeWidth };
      store.addItems(c.key, [it]);
      return;
    }
    if (tiny) {
      if (s.tool === 'field') {
        // A tap adds a default-size field.
        const w = store.prefs.fieldKind === 'check' ? 12 : 160;
        const h = store.prefs.fieldKind === 'check' ? 12 : 20;
        this.addField(c, { x: s.x0, y: s.y0 - h / 2, w, h });
      }
      return;
    }
    if (s.tool === 'redact') {
      if (store.redactAllPages && store.pages.length > 1) {
        // The same spot on every page (as it is seen on screen), in one undo step.
        store.updateDocPages((p) => ({ ...p, items: [...p.items, { id: uid('r'), type: 'redact', ...sameSpot(c.entry, r, p) }] }));
        toast('Marked the same area on all pages.', 'ok');
      } else store.addItems(c.key, [{ id: uid('r'), type: 'redact', ...r }]);
    } else if (s.tool === 'crop') {
      this.applyCrop(c, r);
    } else if (s.tool === 'field') {
      this.addField(c, r);
    } else if (s.tool === 'link') {
      void import('./dialog').then(async ({ ask }) => {
        const res = await ask({
          title: 'Add a link',
          body: 'People who open the saved PDF in another reader can click this area. Nib-E keeps links inactive in safe mode.',
          input: { label: 'Web address', placeholder: 'https://example.com', type: 'url' },
          actions: [
            { label: 'Cancel', value: false, kind: 'quiet' },
            { label: 'Add link', value: true, kind: 'primary' },
          ],
        });
        if (!res?.value) return;
        let url = res.text.trim();
        if (!url) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
        if (!/^(https?|mailto):/i.test(url)) {
          toast('Only web (https) and email links can be added.', 'error');
          return;
        }
        store.addItems(c.key, [{ id: uid('l'), type: 'link', ...r, url }]);
      });
    }
  }

  /** Crop tool: the dragged area becomes the visible part of this page, the chosen pages, or all pages. */
  private applyCrop(c: Card, r: Rect): void {
    const min = 36; // half an inch: smaller is almost always a slip
    if (r.w < min || r.h < min) {
      toast('That area is very small. Drag over the part of the page you want to keep.');
      return;
    }
    const scope = store.cropScope;
    const keys = new Set(scope === 'all' ? store.pages.map((p) => p.key) : scope === 'selected' && store.selected.size ? [...store.selected] : [c.key]);
    keys.add(c.key);
    const clamp = (p: PageEntry, q: Rect): Rect => {
      const x = Math.max(0, q.x);
      const y = Math.max(0, q.y);
      return { x, y, w: Math.min(p.w, q.x + q.w) - x, h: Math.min(p.h, q.y + q.h) - y };
    };
    store.updateDocPages((p) => (keys.has(p.key) ? { ...p, crop: clamp(p, sameSpot(c.entry, r, p)) } : p));
    toast(keys.size > 1 ? 'Pages cropped. Undo brings the full pages back.' : 'Page cropped. Undo brings the full page back.', 'ok');
  }

  private addField(c: Card, r: Rect): void {
    const n = c.entry.items.filter((it) => it.type === 'field').length + 1;
    const kind = store.prefs.fieldKind;
    const item: FieldItem = { id: uid('f'), type: 'field', kind, ...r, name: `${kind === 'check' ? 'Checkbox' : 'Text field'} ${n}` };
    store.addItems(c.key, [item]);
    if (!store.prefs.fillable) store.setPrefs({ fillable: true });
  }

  // ---------- selecting the PDF's own text ----------

  private startTextSelection(c: Card, e: PointerEvent, x: number, y: number): void {
    const now = performance.now();
    const near = now - this.lastDown.t < 450 && Math.hypot(e.clientX - this.lastDown.x, e.clientY - this.lastDown.y) < 6;
    const clicks = near ? Math.min(3, this.lastDown.n + 1) : 1;
    this.lastDown = { t: now, x: e.clientX, y: e.clientY, n: clicks };
    const chars = pageChars(c.entry).filter((ch) => ch.x1 > ch.x0 && ch.y1 > ch.y0);
    this.session = { kind: 'textsel', id: e.pointerId, card: c, chars, from: 0, to: 0, cx: e.clientX, cy: e.clientY, moved: false, clicks };
    if (!chars.length) return;
    e.preventDefault();
    this.pagesEl.setPointerCapture(e.pointerId);
    const at = this.nearestChar(chars, x, y);
    const s = this.session;
    if (clicks >= 2) {
      const [a, b] = clicks === 2 ? this.wordAround(chars, at) : this.lineAround(chars, at);
      s.from = a;
      s.to = b;
      this.textSel = { card: c, chars, from: a, to: b };
      this.renderTextSelection(true);
      return;
    }
    s.from = s.to = at;
    this.clearTextSelection();
  }

  private wordAround(chars: PChar[], at: number): [number, number] {
    const word = (i: number) => i >= 0 && i < chars.length && /[\p{L}\p{N}_@.\-'’]/u.test(chars[i].ch) && this.sameLine(chars[i], chars[at]);
    let a = at;
    let b = at;
    while (word(a - 1) && chars[a].x0 - chars[a - 1].x1 < chars[a].size * 0.25) a--;
    while (word(b + 1) && chars[b + 1].x0 - chars[b].x1 < chars[b].size * 0.25) b++;
    return [a, b];
  }

  private lineAround(chars: PChar[], at: number): [number, number] {
    let a = at;
    let b = at;
    while (a > 0 && this.sameLine(chars[a - 1], chars[at])) a--;
    while (b < chars.length - 1 && this.sameLine(chars[b + 1], chars[at])) b++;
    return [a, b];
  }

  private sameLine(p: PChar, q: PChar): boolean {
    const h = Math.max(q.y1 - q.y0, 1);
    return Math.abs((p.y0 + p.y1) / 2 - (q.y0 + q.y1) / 2) < h * 0.5;
  }

  /** The selected text, with spaces and line breaks where the PDF has them. */
  selectedText(): string {
    const t = this.textSel;
    if (!t) return '';
    const [a, b] = t.from <= t.to ? [t.from, t.to] : [t.to, t.from];
    const lo = t.chars[a].i;
    const hi = t.chars[b].i;
    const all = pageChars(t.card.entry).filter((c) => c.i >= lo && c.i <= hi);
    let out = '';
    let prev: PChar | null = null;
    for (const c of all) {
      if (c.ch === '\r' || c.ch === '\n') {
        if (!out.endsWith('\n')) out += '\n';
        prev = null;
        continue;
      }
      if (prev && c.x1 > c.x0 && !/\s/.test(c.ch)) {
        if (!this.sameLine(c, prev)) {
          if (!out.endsWith('\n')) out += '\n';
        } else if (c.x0 - prev.x1 > Math.min(prev.size, c.size) * 0.2 && !/\s$/.test(out)) out += ' ';
      }
      out += c.ch;
      if (c.x1 > c.x0 && !/\s/.test(c.ch)) prev = c;
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  /** Copies the selected PDF text. False when nothing is selected. */
  copyTextSelection(): boolean {
    const text = this.selectedText();
    if (!text) return false;
    void copyToClipboard(text).then((ok) => toast(ok ? 'Copied.' : 'Could not copy. Select the text and try Ctrl+C again.', ok ? 'ok' : 'error', 1800));
    return true;
  }

  hasTextSelection(): boolean {
    return !!this.textSel;
  }

  /** Ctrl+A with the Select tool: all text of the current page. */
  selectAllText(): boolean {
    const p = this.entries()[this.isMain() ? store.current : 0];
    const c = p && this.cards.get(p.key);
    if (!c) return false;
    const chars = pageChars(c.entry).filter((ch) => ch.x1 > ch.x0 && ch.y1 > ch.y0);
    if (!chars.length) return false;
    this.textSel = { card: c, chars, from: 0, to: chars.length - 1 };
    this.renderTextSelection(true);
    return true;
  }

  clearTextSelection(): void {
    this.textSel = null;
    this.textSelEl?.remove();
    this.textSelEl = null;
  }

  private renderTextSelection(withCopy = !!this.textSelEl?.querySelector('.tsel-copy')): void {
    const t = this.textSel;
    if (!t || !this.cards.has(t.card.key)) {
      this.clearTextSelection();
      return;
    }
    const c = this.cards.get(t.card.key)!;
    t.card = c;
    const [a, b] = t.from <= t.to ? [t.from, t.to] : [t.to, t.from];
    const rects = lineRects(t.chars.slice(a, b + 1));
    let el = this.textSelEl;
    if (!el || el.parentElement !== c.paper) {
      el?.remove();
      el = document.createElement('div');
      el.className = 'layer-tsel';
      c.paper.append(el);
      this.textSelEl = el;
    }
    const k = this.k;
    let last = { x: 0, y: 0 };
    el.innerHTML = rects
      .map((r) => {
        const q = rectToScreen(c.entry, { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 });
        last = { x: (q.x + q.w) * k, y: (q.y + q.h) * k };
        return `<span class="tsel-rect" style="left:${q.x * k}px;top:${q.y * k}px;width:${q.w * k}px;height:${q.h * k}px"></span>`;
      })
      .join('');
    if (withCopy && rects.length) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsel-copy';
      btn.innerHTML = 'Copy';
      btn.title = 'Copy (Ctrl+C)';
      btn.style.left = `${Math.max(0, last.x - 60)}px`;
      btn.style.top = `${last.y + 6}px`;
      btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      btn.addEventListener('click', () => this.copyTextSelection());
      el.append(btn);
    }
  }

  private nearestChar(chars: PChar[], x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    chars.forEach((c, i) => {
      const dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
      const dy = y < c.y0 ? c.y0 - y : y > c.y1 ? y - c.y1 : 0;
      const d = dy * 3 + dx;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private markupRects(s: Extract<Session, { kind: 'markup' }>): Rect[] {
    const [a, b] = s.from <= s.to ? [s.from, s.to] : [s.to, s.from];
    return lineRects(s.chars.slice(a, b + 1));
  }

  private drawMarkupPreview(): void {
    const s = this.session;
    if (!s || s.kind !== 'markup') return;
    s.raf = 0;
    const live = this.ensureLive(s.card);
    const ctx = live.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    ctx.setTransform(...pageMatrix(s.card.entry, fitScale(s.card.entry, this.k * dpr())));
    drawItems(ctx, [{ id: '__m', type: 'markup', kind: store.prefs.markup, color: store.prefs.markupColor, rects: this.markupRects(s) }]);
  }

  private finishMarkup(s: Extract<Session, { kind: 'markup' }>): void {
    const rects = this.markupRects(s);
    if (!rects.length) return;
    store.addItems(s.card.key, [{ id: uid('mk'), type: 'markup', kind: store.prefs.markup, color: store.prefs.markupColor, rects }]);
  }

  private async tap(c: Card, tool: Tool, x: number, y: number): Promise<void> {
    const upright = uprightRot(c.entry);
    if (tool === 'retype') {
      this.retypeAt(c, x, y);
      return;
    }
    if (tool === 'text') {
      const p = store.prefs;
      const item: TextItem = fitText({
        id: uid('t'),
        type: 'text',
        x,
        y: y - p.textSize * 0.9,
        w: p.textSize * 4,
        h: p.textSize * 1.5,
        rot: upright,
        text: '',
        font: p.textFont,
        size: p.textSize,
        bold: p.textBold,
        italic: p.textItalic,
        color: p.textColor,
        valign: 'top',
        wrap: false,
      });
      // Anchor the box at the tap point on screen, whatever the page rotation.
      const anchored = upright === 0 ? item : this.anchorAt(c.entry, item, x, y);
      this.startEdit(c, anchored, true);
      return;
    }
    if (tool === 'sign') {
      const sig = await getSignature();
      if (!sig) return;
      const [sx, sy] = this.screenOf(c.entry, x, y);
      const strokes = placeSignature(sig, c.entry, sx, sy, store.prefs.penColor);
      if (strokes.length) {
        store.addItems(c.key, strokes);
        toast('Signature placed. Undo removes it.');
      }
      return;
    }
    if (tool === 'mark') {
      const s = Math.max(8, store.prefs.textSize);
      store.addItems(c.key, [{ id: uid('m'), type: 'mark', x: x - s / 2, y: y - s / 2, w: s, h: s, shape: store.prefs.markShape, color: store.prefs.textColor }]);
      return;
    }
    if (tool === 'note') {
      const note: NoteItem = { id: uid('n'), type: 'note', x: x - 2, y: y - 2, text: '', color: store.prefs.noteColor };
      this.openNote(c, note, true);
      return;
    }
    if (tool === 'stamp') {
      const st = store.prefs.stamp;
      const sub = store.prefs.stampDate ? new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const h = sub ? 44 : 34;
      const base = stampLayout({ label: st.label, sub, w: 1000, h, rot: 0 }).size;
      const w = Math.max(90, measure(st.label, 'sans', base, true, false) / 0.84 + 8);
      const [cw, ch] = upright % 2 ? [h, w] : [w, h];
      const item: StampItem = { id: uid('st'), type: 'stamp', x: x - cw / 2, y: y - ch / 2, w: cw, h: ch, rot: upright, label: st.label, sub, color: st.color };
      store.addItems(c.key, [item]);
      store.select({ key: c.key, id: item.id });
      store.setTool('select');
      return;
    }
    if (tool === 'image') {
      const id = store.pendingImage;
      const img = id ? images.get(id) : null;
      if (!id || !img) {
        toast('Choose a picture first: Content editor → Image.');
        return;
      }
      // Natural size at 96 pixels per inch, capped so large photos stay manageable.
      const max = store.pendingImageSize;
      const f = Math.min(0.75, max / Math.max(img.w, img.h));
      const w = img.w * f;
      const h = img.h * f;
      const [cw, ch] = upright % 2 ? [h, w] : [w, h];
      const item = { id: uid('im'), type: 'image' as const, x: x - cw / 2, y: y - ch / 2, w: cw, h: ch, rot: upright, image: id };
      store.addItems(c.key, [item]);
      store.pendingImage = null;
      store.pendingImageSize = 220;
      store.select({ key: c.key, id: item.id });
      store.setTool('select');
    }
  }

  /** Screen (shown) point for a page point. */
  private screenOf(p: PageEntry, x: number, y: number): [number, number] {
    const r = rectToScreen(p, { x, y, w: 0, h: 0 });
    return [r.x, r.y];
  }

  /** Places a new text box so its upright top-left sits at the tapped point. */
  private anchorAt(p: PageEntry, t: TextItem, x: number, y: number): TextItem {
    const [sx, sy] = this.screenOf(p, x, y);
    const { w: cw, h: ch } = t.rot % 2 ? { w: t.h, h: t.w } : { w: t.w, h: t.h };
    const r = rectToPage(p, { x: sx, y: sy - t.size * 0.9, w: cw, h: ch });
    return { ...t, ...r };
  }

  /** New geometry for an item after a resize to page rect r. */
  private resized(p: PageEntry, it: Item, r: Rect): Item {
    void p;
    if (isBoxItem(it)) {
      if (it.type === 'text') {
        const next: TextItem = { ...it, x: r.x, y: r.y, w: r.w, h: r.h, wrap: it.field ? it.wrap : true };
        return next;
      }
      return { ...it, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    const b = itemBounds(it);
    const sx = r.w / Math.max(0.01, b.w);
    const sy = r.h / Math.max(0.01, b.h);
    const map = (x: number, y: number): [number, number] => [r.x + (x - b.x) * sx, r.y + (y - b.y) * sy];
    if (it.type === 'ink') return { ...it, pts: it.pts.map(([x, y, pr]) => [...map(x, y), pr] as Pt) };
    if (it.type === 'shape') {
      const [x1, y1] = map(it.x1, it.y1);
      const [x2, y2] = map(it.x2, it.y2);
      return { ...it, x1, y1, x2, y2 };
    }
    return it;
  }

  /** Selected item's page, for keyboard deletion and toolbar actions. */
  deleteSelection(): boolean {
    const sel = store.sel;
    if (!sel || !this.cards.has(sel.key)) return false;
    store.removeItems(sel.key, new Set([sel.id]));
    store.select(null);
    return true;
  }

  hasCard(key: string): boolean {
    return this.cards.has(key);
  }
}
