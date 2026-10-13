// Page thumbnails and page actions: insert, rotate, reorder, delete, extract.
import { pageMatrix, shownSize, uid, type PageEntry, type Template } from '../model';
import { baseName, saveSelection } from '../doc';
import { store } from '../store';
import { icon } from './icons';
import { drawDecor, drawItems } from './draw';
import { bitmapKey, cancelRender, requestRender } from './render';
import { toast } from './toast';
import type { Viewer } from './viewer';

const THUMB_W = 132;

interface Thumb {
  entry: PageEntry;
  li: HTMLLIElement;
  pdf: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  num: HTMLSpanElement;
  box: HTMLInputElement;
  bmp: string;
  inkFor: unknown;
  visible: boolean;
}

export class Sidebar {
  private thumbs = new Map<string, Thumb>();
  private io: IntersectionObserver;
  private anchor: string | null = null;
  private dragKeys: string[] = [];
  private list: HTMLOListElement;

  constructor(private root: HTMLElement, private viewer: Viewer, private onBusy: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>) {
    this.list = root.querySelector('#thumbs') as HTMLOListElement;
    this.io = new IntersectionObserver((es) => this.onVisible(es), { root: this.list, rootMargin: '400px 0px' });
    this.buildActions();
    store.on((why) => {
      if (why === 'doc' || why === 'pages' || why === 'items' || why === 'decor') this.sync();
      if (why === 'doc' || why === 'pages' || why === 'selection' || why === 'current') this.marks();
    });
    this.list.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.pages.length) {
        e.preventDefault();
        this.remove();
      }
    });
  }

  private buildActions(): void {
    const bar = this.root.querySelector('#side-actions') as HTMLElement;
    bar.innerHTML = `
      <div class="menu-wrap">
        <button class="icon-btn" type="button" data-act="insert" aria-haspopup="menu" aria-expanded="false" title="Insert a page after this one">${icon('pageAdd')}</button>
        <div class="menu" role="menu" hidden>
          <button type="button" role="menuitem" data-tpl="blank">${icon('blank')}Blank page</button>
          <button type="button" role="menuitem" data-tpl="lined">${icon('lines')}Lined page</button>
          <button type="button" role="menuitem" data-tpl="grid">${icon('grid')}Grid page</button>
        </div>
      </div>
      <button class="icon-btn" type="button" data-act="rotL" title="Rotate left">${icon('rotL')}</button>
      <button class="icon-btn" type="button" data-act="rotR" title="Rotate right">${icon('rotR')}</button>
      <button class="icon-btn" type="button" data-act="up" title="Move up">${icon('up')}</button>
      <button class="icon-btn" type="button" data-act="down" title="Move down">${icon('down')}</button>
      <button class="icon-btn" type="button" data-act="extract" title="Save these pages as a new PDF">${icon('extract')}</button>
      <button class="icon-btn danger" type="button" data-act="delete" title="Delete">${icon('trash')}</button>`;
    const menu = bar.querySelector('.menu') as HTMLElement;
    const insertBtn = bar.querySelector('[data-act="insert"]') as HTMLButtonElement;
    const closeMenu = () => {
      menu.hidden = true;
      insertBtn.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.menu-wrap')) closeMenu();
    });
    bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const tpl = btn.dataset.tpl as Template | undefined;
      if (tpl) {
        closeMenu();
        this.insert(tpl);
        return;
      }
      const keys = store.targetKeys();
      switch (btn.dataset.act) {
        case 'insert':
          menu.hidden = !menu.hidden;
          insertBtn.setAttribute('aria-expanded', String(!menu.hidden));
          break;
        case 'rotL':
          store.rotate(keys, -1);
          break;
        case 'rotR':
          store.rotate(keys, 1);
          break;
        case 'up':
          store.shift(keys, -1);
          this.follow(keys);
          break;
        case 'down':
          store.shift(keys, 1);
          this.follow(keys);
          break;
        case 'extract':
          if (keys.length) void this.onBusy('Saving pages…', () => saveSelection(keys));
          break;
        case 'delete':
          this.remove();
          break;
      }
    });
  }

  private follow(keys: string[]): void {
    const i = store.pages.findIndex((p) => p.key === keys[0]);
    if (i >= 0) this.viewer.scrollToPage(i);
  }

  private insert(t: Template): void {
    const cur = store.pages[store.current];
    const size = cur ? shownSize(cur) : { w: 595.28, h: 841.89 };
    const key = uid('p');
    store.insertBlank(store.current, t, size.w, size.h, key);
    const i = store.pages.findIndex((p) => p.key === key);
    requestAnimationFrame(() => this.viewer.scrollToPage(i));
  }

  private remove(): void {
    const keys = store.targetKeys();
    if (!keys.length) return;
    if (keys.length >= store.pages.length) {
      toast('A PDF needs at least one page. Keep one page or open another file.', 'error');
      return;
    }
    store.remove(keys);
    store.selected.clear();
    store.emit('selection');
    toast(`${keys.length === 1 ? 'Page' : `${keys.length} pages`} deleted. Undo brings ${keys.length === 1 ? 'it' : 'them'} back.`);
  }

  // ---------- list ----------

  private sync(): void {
    const pages = store.pages;
    const keep = new Set(pages.map((p) => p.key));
    for (const [k, t] of this.thumbs) {
      if (!keep.has(k)) {
        this.io.unobserve(t.li);
        cancelRender(`t:${k}`);
        t.li.remove();
        this.thumbs.delete(k);
      }
    }
    let prev: Element | null = null;
    pages.forEach((entry, i) => {
      let t = this.thumbs.get(entry.key);
      if (!t) {
        t = this.make(entry);
        this.thumbs.set(entry.key, t);
      }
      t.entry = entry;
      const expected: Element | null = prev ? prev.nextElementSibling : this.list.firstElementChild;
      if (expected !== t.li) {
        if (prev) prev.after(t.li);
        else this.list.prepend(t.li);
      }
      prev = t.li;
      t.num.textContent = String(i + 1);
      const { w, h } = shownSize(entry);
      t.pdf.style.aspectRatio = `${w} / ${h}`;
      if (t.visible) this.paint(t);
    });
    (this.root.querySelector('#side-count') as HTMLElement).textContent = String(pages.length);
  }

  private make(entry: PageEntry): Thumb {
    const li = document.createElement('li');
    li.className = 'thumb';
    li.dataset.key = entry.key;
    li.draggable = true;
    li.innerHTML = `
      <button class="thumb-hit" type="button"><span class="thumb-paper"><canvas class="t-pdf"></canvas><canvas class="t-ink"></canvas></span></button>
      <label class="thumb-foot"><input type="checkbox" aria-label="Select page" /><span class="thumb-num"></span></label>`;
    const t: Thumb = {
      entry,
      li,
      pdf: li.querySelector('.t-pdf') as HTMLCanvasElement,
      ink: li.querySelector('.t-ink') as HTMLCanvasElement,
      num: li.querySelector('.thumb-num') as HTMLSpanElement,
      box: li.querySelector('input') as HTMLInputElement,
      bmp: '',
      inkFor: null,
      visible: false,
    };
    (li.querySelector('.thumb-hit') as HTMLButtonElement).addEventListener('click', (e) => this.click(t, e));
    t.box.addEventListener('change', () => {
      if (t.box.checked) store.selected.add(t.entry.key);
      else store.selected.delete(t.entry.key);
      this.anchor = t.entry.key;
      store.emit('selection');
    });
    li.addEventListener('dragstart', (e) => {
      this.dragKeys = store.selected.has(t.entry.key) ? store.targetKeys() : [t.entry.key];
      e.dataTransfer?.setData('text/plain', 'nib-pages');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      this.clearDrop();
    });
    li.addEventListener('dragover', (e) => {
      if (!this.dragKeys.length) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      this.clearDrop();
      li.classList.add(after ? 'drop-after' : 'drop-before');
    });
    li.addEventListener('drop', (e) => {
      if (!this.dragKeys.length) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const pages = store.pages;
      const i = pages.findIndex((p) => p.key === t.entry.key);
      let before: string | null = after ? pages[i + 1]?.key ?? null : t.entry.key;
      while (before && this.dragKeys.includes(before)) {
        const j = pages.findIndex((p) => p.key === before);
        before = pages[j + 1]?.key ?? null;
      }
      store.moveTo(this.dragKeys, before);
      this.dragKeys = [];
      this.clearDrop();
    });
    this.io.observe(li);
    return t;
  }

  private clearDrop(): void {
    this.list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  private click(t: Thumb, e: MouseEvent): void {
    const pages = store.pages;
    const i = pages.findIndex((p) => p.key === t.entry.key);
    if (e.shiftKey && this.anchor) {
      const a = pages.findIndex((p) => p.key === this.anchor);
      const [lo, hi] = a < i ? [a, i] : [i, a];
      for (let j = lo; j <= hi; j++) store.selected.add(pages[j].key);
      store.emit('selection');
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (store.selected.has(t.entry.key)) store.selected.delete(t.entry.key);
      else store.selected.add(t.entry.key);
      this.anchor = t.entry.key;
      store.emit('selection');
      return;
    }
    this.anchor = t.entry.key;
    if (store.selected.size) {
      store.selected.clear();
      store.emit('selection');
    }
    this.viewer.scrollToPage(i);
    if (window.matchMedia('(max-width: 760px)').matches) document.getElementById('app')?.classList.add('side-closed');
  }

  private marks(): void {
    const pages = store.pages;
    pages.forEach((p, i) => {
      const t = this.thumbs.get(p.key);
      if (!t) return;
      const sel = store.selected.has(p.key);
      t.li.classList.toggle('selected', sel);
      t.li.classList.toggle('current', i === store.current);
      t.box.checked = sel;
    });
    const target = this.root.querySelector('#side-target') as HTMLElement;
    target.textContent = store.selected.size
      ? `${store.selected.size} selected`
      : pages.length
        ? `Page ${store.current + 1}`
        : '';
    if (store.selected.size) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'link-btn';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        store.selected.clear();
        store.emit('selection');
      });
      target.append(' · ', clear);
    }
    const cur = this.thumbs.get(pages[store.current]?.key ?? '');
    if (cur && !store.selected.size) cur.li.scrollIntoView({ block: 'nearest' });
  }

  private onVisible(es: IntersectionObserverEntry[]): void {
    for (const e of es) {
      const t = this.thumbs.get((e.target as HTMLElement).dataset.key!);
      if (!t) continue;
      t.visible = e.isIntersecting;
      if (t.visible) this.paint(t);
      else cancelRender(`t:${t.entry.key}`);
    }
  }

  private paint(t: Thumb): void {
    const entry = t.entry;
    const ratio = Math.min((window.devicePixelRatio || 1) * (store.prefs.uiScale || 1), 3);
    const scale = (THUMB_W * ratio) / shownSize(entry).w;
    const key = bitmapKey(entry);
    if (t.bmp !== key) {
      const index = store.pages.indexOf(entry);
      requestRender({
        id: `t:${entry.key}`,
        page: entry,
        scale,
        priority: 1e6 + index,
        done: (img) => {
          if (!img || this.thumbs.get(entry.key) !== t) return;
          t.pdf.width = img.width;
          t.pdf.height = img.height;
          t.pdf.getContext('2d')!.putImageData(img, 0, 0);
          t.bmp = key;
        },
      });
    }
    const plan = store.plan;
    const index = store.pages.indexOf(entry);
    const inkKey = [entry.items, plan.hf, plan.wm, index, store.pages.length];
    if (!Array.isArray(t.inkFor) || inkKey.some((v, i) => v !== (t.inkFor as unknown[])[i])) {
      const { w, h } = shownSize(entry);
      t.ink.width = Math.round(w * scale);
      t.ink.height = Math.round(h * scale);
      const ctx = t.ink.getContext('2d')!;
      ctx.setTransform(...pageMatrix(entry, scale));
      drawItems(ctx, entry.items);
      if (plan.hf || plan.wm) {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawDecor(ctx, entry, index + 1, store.pages.length, baseName(), plan.hf, plan.wm, w, h);
      }
      t.inkFor = inkKey;
    }
  }
}
