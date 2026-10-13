// "My stamps": stamps people design in Nib or upload as PNG. They are kept in
// this browser only (localStorage) and placed on pages as transparent images.
import { loadImage } from '../doc';
import { store } from '../store';
import { icon } from './icons';
import { toast } from './toast';

type Kind = 'text' | 'rect' | 'round' | 'ellipse' | 'line' | 'image';

/** One element of a designed stamp, in stage units (the stage is STAGE_W × STAGE_H). */
export interface El {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text?: string;
  font?: 'sans' | 'serif' | 'mono';
  bold?: boolean;
  size?: number;
  stroke?: number;
  fill?: boolean;
  /** Image elements: a PNG/JPEG data URL. */
  src?: string;
}

export interface MyStamp {
  id: string;
  name: string;
  /** Designed in Nib (editable) or an uploaded picture. */
  design?: El[];
  png?: string;
  /** Small preview for the list. */
  thumb: string;
}

const KEY = 'nib.stamps.v1';
export const STAGE_W = 480;
export const STAGE_H = 220;
const COLORS = ['#c62828', '#2f3fd6', '#13804f', '#1b1f2e', '#7b2fd6', '#d97706'];
const FONTS: Record<NonNullable<El['font']>, string> = {
  sans: '"Hanken Grotesk", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

const uidS = () => Math.random().toString(36).slice(2, 10);

// ---------- storage ----------

export function myStamps(): MyStamp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as MyStamp[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function store_(list: MyStamp[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    toast('Not enough space in this browser to keep another stamp. Delete one first.', 'error', 7000);
    return false;
  }
}

function putStamp(s: MyStamp): boolean {
  const list = myStamps();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.push(s);
  return store_(list);
}

export function deleteStamp(id: string): void {
  store_(myStamps().filter((s) => s.id !== id));
}

// ---------- drawing ----------

const imgCache = new Map<string, HTMLImageElement>();
function imageFor(src: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(src);
  if (hit?.complete) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const im = hit ?? new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    if (!hit) {
      im.src = src;
      imgCache.set(src, im);
    }
  });
}

function today(): string {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function textOf(el: El): string {
  return (el.text ?? '').replace(/\{date\}/g, today());
}

function fontOf(el: El): string {
  return `${el.bold ? 700 : 500} ${el.size ?? 32}px ${FONTS[el.font ?? 'sans']}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Text elements are as big as their text. */
function sizeText(el: El): void {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = fontOf(el);
  const t = textOf(el) || ' ';
  el.w = Math.max(8, measureCtx.measureText(t).width);
  el.h = (el.size ?? 32) * 1.2;
}

/** Draws a design. Images must be loaded first (see `loadImages`). */
function drawDesign(ctx: CanvasRenderingContext2D, els: El[]): void {
  for (const el of els) {
    ctx.save();
    ctx.strokeStyle = el.color;
    ctx.fillStyle = el.color;
    const sw = el.stroke ?? 4;
    ctx.lineWidth = sw;
    const inset = el.fill ? 0 : sw / 2;
    const x = el.x + inset;
    const y = el.y + inset;
    const w = Math.max(1, el.w - inset * 2);
    const h = Math.max(1, el.h - inset * 2);
    switch (el.kind) {
      case 'text':
        ctx.font = fontOf(el);
        ctx.textBaseline = 'middle';
        ctx.fillText(textOf(el), el.x, el.y + el.h / 2);
        break;
      case 'rect':
        if (el.fill) ctx.fillRect(x, y, w, h);
        else ctx.strokeRect(x, y, w, h);
        break;
      case 'round': {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.22);
        if (el.fill) ctx.fill();
        else ctx.stroke();
        break;
      }
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (el.fill) ctx.fill();
        else ctx.stroke();
        break;
      case 'line':
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(el.x, el.y + el.h / 2);
        ctx.lineTo(el.x + el.w, el.y + el.h / 2);
        ctx.stroke();
        break;
      case 'image': {
        const im = el.src ? imgCache.get(el.src) : undefined;
        if (im?.complete) ctx.drawImage(im, el.x, el.y, el.w, el.h);
        break;
      }
    }
    ctx.restore();
  }
}

async function loadImages(els: El[]): Promise<void> {
  await Promise.all(els.filter((e) => e.kind === 'image' && e.src).map((e) => imageFor(e.src!).catch(() => undefined)));
}

/** Renders a design to a transparent PNG, trimmed to what is drawn. */
async function renderDesign(els: El[], scale: number): Promise<{ blob: Blob; url: string; w: number; h: number } | null> {
  await loadImages(els);
  for (const el of els) if (el.kind === 'text') sizeText(el);
  const c = document.createElement('canvas');
  c.width = Math.round(STAGE_W * scale);
  c.height = Math.round(STAGE_H * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  drawDesign(ctx, els);
  // Trim empty margins.
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width;
  let y0 = c.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(2 * scale);
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(c.width - 1, x1 + pad);
  y1 = Math.min(c.height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(c, -x0, -y0);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) return null;
  return { blob, url: out.toDataURL('image/png'), w: out.width, h: out.height };
}

/** A small preview picture (fits 160 × 72). */
async function thumbOf(src: string): Promise<string> {
  const im = await imageFor(src);
  const f = Math.min(1, 160 / im.naturalWidth, 72 / im.naturalHeight);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(im.naturalWidth * f * 2));
  c.height = Math.max(1, Math.round(im.naturalHeight * f * 2));
  c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// ---------- placing ----------

/** Gets a stamp ready to place: the next click on a page puts it there. */
export async function useStamp(id: string): Promise<boolean> {
  const s = myStamps().find((x) => x.id === id);
  if (!s) return false;
  let blob: Blob | null = null;
  if (s.design) blob = (await renderDesign(structuredClone(s.design), 3))?.blob ?? null;
  else if (s.png) blob = await (await fetch(s.png)).blob();
  if (!blob) return false;
  const img = await loadImage(blob);
  store.pendingImage = img.id;
  store.pendingImageSize = 150;
  store.setTool('image');
  store.emit('tool');
  return true;
}

/** Adds a PNG (or other picture) as a stamp. Big pictures are scaled down. */
export async function addPngStamp(file: File): Promise<MyStamp | null> {
  const url = URL.createObjectURL(file);
  try {
    const im = await imageFor(url);
    const f = Math.min(1, 900 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * f));
    c.height = Math.max(1, Math.round(im.naturalHeight * f));
    c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
    const png = c.toDataURL('image/png');
    const s: MyStamp = { id: uidS(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Stamp', png, thumb: await thumbOf(png) };
    return putStamp(s) ? s : null;
  } catch {
    toast(`${file.name} could not be read as a picture.`, 'error');
    return null;
  } finally {
    imgCache.delete(url);
    URL.revokeObjectURL(url);
  }
}

// ---------- designer ----------

function preset(name: 'box' | 'seal' | 'blank'): El[] {
  const red = COLORS[0];
  if (name === 'blank') return [];
  if (name === 'seal') {
    const els: El[] = [
      { id: uidS(), kind: 'ellipse', x: 150, y: 20, w: 180, h: 180, color: COLORS[1], stroke: 5 },
      { id: uidS(), kind: 'ellipse', x: 162, y: 32, w: 156, h: 156, color: COLORS[1], stroke: 2 },
      { id: uidS(), kind: 'text', x: 0, y: 0, w: 0, h: 0, color: COLORS[1], text: 'RECEIVED', font: 'sans', bold: true, size: 26 },
      { id: uidS(), kind: 'text', x: 0, y: 0, w: 0, h: 0, color: COLORS[1], text: '{date}', font: 'sans', bold: false, size: 16 },
    ];
    centre(els[2], 240, 96);
    centre(els[3], 240, 128);
    return els;
  }
  const els: El[] = [
    { id: uidS(), kind: 'round', x: 90, y: 40, w: 300, h: 130, color: red, stroke: 6 },
    { id: uidS(), kind: 'text', x: 0, y: 0, w: 0, h: 0, color: red, text: 'CHECKED', font: 'sans', bold: true, size: 44 },
    { id: uidS(), kind: 'text', x: 0, y: 0, w: 0, h: 0, color: red, text: '{date}', font: 'sans', bold: false, size: 20 },
  ];
  centre(els[1], 240, 92);
  centre(els[2], 240, 136);
  return els;
}

function centre(el: El, cx: number, cy: number): void {
  if (el.kind === 'text') sizeText(el);
  el.x = cx - el.w / 2;
  el.y = cy - el.h / 2;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Opens the stamp designer. Drag elements to move them, drag the corner
 * handle to resize. Returns the saved stamp, or null when cancelled.
 */
export function openStampMaker(edit?: MyStamp): Promise<MyStamp | null> {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog stamp-maker';
  dlg.setAttribute('aria-label', 'Design a stamp');
  document.getElementById('app')!.append(dlg);

  let els: El[] = edit?.design ? structuredClone(edit.design) : preset('box');
  let sel: El | null = els[1] ?? null;
  let color = sel?.color ?? COLORS[0];

  dlg.innerHTML = `
    <div class="sm-head"><h2>${edit ? 'Edit stamp' : 'Design a stamp'}</h2><span class="grow"></span>
      <span class="sm-start">Start from
        <button class="btn sm" type="button" data-preset="box">Box</button>
        <button class="btn sm" type="button" data-preset="seal">Round seal</button>
        <button class="btn sm" type="button" data-preset="blank">Empty</button>
      </span></div>
    <p class="sm-hint">Drag to move, drag the blue dot to resize. Drop a logo onto the stage to add it. <code>{date}</code> becomes the date when you place the stamp.</p>
    <div class="sm-add" role="toolbar" aria-label="Add to the stamp">
      <button class="btn sm" type="button" data-add="text">${icon('text')}Text</button>
      <button class="btn sm" type="button" data-add="date">${icon('date')}Date</button>
      <button class="btn sm" type="button" data-add="round">${icon('rect')}Box</button>
      <button class="btn sm" type="button" data-add="ellipse">${icon('ellipse')}Circle</button>
      <button class="btn sm" type="button" data-add="line">${icon('line')}Line</button>
      <button class="btn sm" type="button" data-add="image">${icon('image')}Picture…</button>
    </div>
    <div class="sm-stage-wrap"><canvas class="sm-stage" width="${STAGE_W}" height="${STAGE_H}" tabindex="0" aria-label="Stamp stage"></canvas></div>
    <div class="sm-props"></div>
    <div class="dialog-actions">
      <label class="field-label sm sm-name">Name<input class="text-input" id="sm-name" maxlength="40" value="${esc(edit?.name ?? '')}" placeholder="e.g. Checked"/></label>
      <span class="grow"></span>
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" type="button" data-act="save">Save stamp</button>
    </div>`;

  const canvas = dlg.querySelector('.sm-stage') as HTMLCanvasElement;
  const props = dlg.querySelector('.sm-props') as HTMLElement;
  const ctx = canvas.getContext('2d')!;
  const HANDLE = 9;

  const layout = () => {
    const ratio = Math.min(3, (window.devicePixelRatio || 1) * (store.prefs.uiScale || 1));
    canvas.width = Math.round(STAGE_W * ratio);
    canvas.height = Math.round(STAGE_H * ratio);
    draw();
  };

  const draw = () => {
    const ratio = canvas.width / STAGE_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const el of els) if (el.kind === 'text') sizeText(el);
    drawDesign(ctx, els);
    if (sel) {
      ctx.save();
      ctx.strokeStyle = '#2f3fd6';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sel.x - 3, sel.y - 3, sel.w + 6, sel.h + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sel.x + sel.w + 3, sel.y + sel.h + 3, HANDLE / 2 + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2f3fd6';
      ctx.beginPath();
      ctx.arc(sel.x + sel.w + 3, sel.y + sel.h + 3, HANDLE / 2 - 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  const renderProps = () => {
    const swatches = `<div class="sm-swatches">${COLORS.map((c) => `<button type="button" class="swatch sm" style="--sw:${c}" data-color="${c}" aria-label="Colour ${c}" aria-pressed="${(sel?.color ?? color) === c}"></button>`).join('')}</div>`;
    if (!sel) {
      props.innerHTML = `${swatches}<span class="muted small">Click something on the stage to change it.</span>`;
      return;
    }
    const e = sel;
    let html = swatches;
    if (e.kind === 'text') {
      html += `<input class="text-input sm-text" id="sm-text" maxlength="40" value="${esc(e.text ?? '')}" aria-label="Text"/>
        <select id="sm-font" aria-label="Font">${(['sans', 'serif', 'mono'] as const).map((f) => `<option value="${f}" ${e.font === f ? 'selected' : ''}>${f === 'sans' ? 'Sans' : f === 'serif' ? 'Serif' : 'Mono'}</option>`).join('')}</select>
        <button class="opt" type="button" data-prop="bold" aria-pressed="${!!e.bold}" title="Bold">${icon('bold')}</button>
        <label class="sm-range">Size<input type="range" id="sm-size" min="10" max="96" value="${Math.round(e.size ?? 32)}"/></label>`;
    } else if (e.kind !== 'image') {
      html += `<label class="sm-range">Line<input type="range" id="sm-stroke" min="1" max="16" value="${e.stroke ?? 4}"/></label>`;
      if (e.kind !== 'line') html += `<button class="opt wide" type="button" data-prop="fill" aria-pressed="${!!e.fill}">Filled</button>`;
    }
    html += `<span class="grow"></span><button class="btn sm" type="button" data-prop="front">To front</button><button class="btn sm btn-quiet" type="button" data-prop="delete">${icon('trash')}Delete</button>`;
    props.innerHTML = html;
  };

  const select = (el: El | null) => {
    sel = el;
    if (el) color = el.color;
    renderProps();
    draw();
  };

  const toStage = (e: PointerEvent | DragEvent) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * STAGE_W) / r.width, ((e.clientY - r.top) * STAGE_H) / r.height] as const;
  };

  const hit = (x: number, y: number): El | null => {
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      const pad = el.kind === 'line' ? 8 : 4;
      if (x >= el.x - pad && x <= el.x + el.w + pad && y >= el.y - pad && y <= el.y + el.h + pad) {
        // Outlines are only "hit" near their edge, so things inside them stay reachable.
        const outline = (el.kind === 'rect' || el.kind === 'round' || el.kind === 'ellipse') && !el.fill;
        if (outline) {
          const edge = Math.max(10, (el.stroke ?? 4) + 6);
          const inside = x > el.x + edge && x < el.x + el.w - edge && y > el.y + edge && y < el.y + el.h - edge;
          if (inside) continue;
        }
        return el;
      }
    }
    return null;
  };

  let drag: { el: El; mode: 'move' | 'size'; x: number; y: number; start: El } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = toStage(e);
    if (sel && Math.hypot(x - (sel.x + sel.w + 3), y - (sel.y + sel.h + 3)) <= HANDLE + 2) {
      drag = { el: sel, mode: 'size', x, y, start: { ...sel } };
    } else {
      const el = hit(x, y);
      select(el);
      if (el) drag = { el, mode: 'move', x, y, start: { ...el } };
    }
    if (drag) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = toStage(e);
    if (!drag) {
      const overHandle = sel && Math.hypot(x - (sel.x + sel.w + 3), y - (sel.y + sel.h + 3)) <= HANDLE + 2;
      canvas.style.cursor = overHandle ? 'nwse-resize' : hit(x, y) ? 'move' : 'default';
      return;
    }
    const { el, start } = drag;
    const dx = x - drag.x;
    const dy = y - drag.y;
    if (drag.mode === 'move') {
      el.x = Math.round(Math.min(STAGE_W - 10, Math.max(10 - el.w, start.x + dx)));
      el.y = Math.round(Math.min(STAGE_H - 10, Math.max(10 - el.h, start.y + dy)));
    } else if (el.kind === 'text') {
      el.size = Math.min(140, Math.max(8, (start.size ?? 32) * Math.max(0.1, (start.w + dx) / start.w)));
    } else if (el.kind === 'image' || (el.kind === 'ellipse' && e.shiftKey)) {
      const f = Math.max(0.05, Math.max((start.w + dx) / start.w, (start.h + dy) / start.h));
      el.w = Math.max(8, start.w * f);
      el.h = Math.max(8, start.h * f);
    } else {
      el.w = Math.max(8, start.w + dx);
      el.h = el.kind === 'line' ? start.h : Math.max(8, start.h + dy);
    }
    draw();
  });
  const end = () => {
    if (drag?.mode === 'size' && drag.el.kind === 'text') renderProps();
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    if (!sel) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      sel.x += moves[e.key][0];
      sel.y += moves[e.key][1];
      draw();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      els = els.filter((x) => x !== sel);
      select(null);
    }
  });

  const addImage = async (file: File, at?: readonly [number, number]) => {
    if (!file.type.startsWith('image/')) return;
    const src = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    // Keep stored designs small: re-encode big pictures at a modest size.
    const im = await imageFor(src);
    let data = src;
    const f = Math.min(1, 600 / Math.max(im.naturalWidth, im.naturalHeight));
    if (f < 1 || src.length > 400_000) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * f));
      c.height = Math.max(1, Math.round(im.naturalHeight * f));
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
      data = c.toDataURL('image/png');
      await imageFor(data);
    }
    const fit = Math.min(1, 140 / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(16, im.naturalWidth * fit);
    const h = Math.max(16, im.naturalHeight * fit);
    const [cx, cy] = at ?? [STAGE_W / 2, STAGE_H / 2];
    const el: El = { id: uidS(), kind: 'image', x: cx - w / 2, y: cy - h / 2, w, h, color, src: data };
    els.push(el);
    select(el);
  };

  const wrap = dlg.querySelector('.sm-stage-wrap') as HTMLElement;
  wrap.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add('drop');
    }
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove('drop');
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) void addImage(f, toStage(e));
  });

  dlg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.preset) {
      els = preset(b.dataset.preset as 'box' | 'seal' | 'blank');
      select(els.find((x) => x.kind === 'text') ?? null);
    } else if (b.dataset.add) {
      const k = b.dataset.add;
      if (k === 'image') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        input.onchange = () => input.files?.[0] && void addImage(input.files[0]);
        input.click();
        return;
      }
      let el: El;
      if (k === 'text' || k === 'date') {
        el = { id: uidS(), kind: 'text', x: 0, y: 0, w: 0, h: 0, color, text: k === 'date' ? '{date}' : 'TEXT', font: 'sans', bold: k === 'text', size: k === 'date' ? 20 : 36 };
        centre(el, STAGE_W / 2, STAGE_H / 2);
      } else if (k === 'line') el = { id: uidS(), kind: 'line', x: 140, y: STAGE_H / 2 - 6, w: 200, h: 12, color, stroke: 4 };
      else el = { id: uidS(), kind: k as Kind, x: STAGE_W / 2 - 80, y: STAGE_H / 2 - (k === 'ellipse' ? 80 : 50), w: 160, h: k === 'ellipse' ? 160 : 100, color, stroke: 5 };
      els.push(el);
      select(el);
      if (el.kind === 'text') requestAnimationFrame(() => (dlg.querySelector('#sm-text') as HTMLInputElement | null)?.select());
    } else if (b.dataset.color) {
      color = b.dataset.color;
      if (sel) sel.color = color;
      renderProps();
      draw();
    } else if (b.dataset.prop && sel) {
      const p = b.dataset.prop;
      if (p === 'bold') sel.bold = !sel.bold;
      else if (p === 'fill') sel.fill = !sel.fill;
      else if (p === 'front') els = [...els.filter((x) => x !== sel), sel];
      else if (p === 'delete') {
        els = els.filter((x) => x !== sel);
        select(null);
        return;
      }
      renderProps();
      draw();
    } else if (b.dataset.act === 'cancel') finish(null);
    else if (b.dataset.act === 'save') void save();
  });
  props.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (!sel) return;
    if (t.id === 'sm-text') sel.text = t.value;
    else if (t.id === 'sm-size') sel.size = Number(t.value);
    else if (t.id === 'sm-stroke') sel.stroke = Number(t.value);
    else if (t.id === 'sm-font') sel.font = t.value as El['font'];
    draw();
  });
  props.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.id === 'sm-font' && sel) {
      sel.font = t.value as El['font'];
      draw();
    }
  });

  let resolveFn: (v: MyStamp | null) => void = () => undefined;
  const finish = (v: MyStamp | null) => {
    dlg.onclose = null;
    if (dlg.open) dlg.close();
    dlg.remove();
    resolveFn(v);
  };

  const save = async () => {
    const nameInput = dlg.querySelector('#sm-name') as HTMLInputElement;
    const firstText = els.find((x) => x.kind === 'text' && x.text && !x.text.includes('{date}'))?.text;
    const name = nameInput.value.trim() || firstText?.trim() || 'My stamp';
    const design = structuredClone(els);
    const out = await renderDesign(structuredClone(els), 1.5);
    if (!out) {
      toast('The stamp is empty. Add some text or a shape first.', 'error');
      return;
    }
    const s: MyStamp = { id: edit?.id ?? uidS(), name: name.slice(0, 40), design, thumb: await thumbOf(out.url) };
    if (!putStamp(s)) return;
    finish(s);
  };

  return new Promise((resolve) => {
    resolveFn = resolve;
    dlg.onclose = () => finish(null);
    dlg.showModal();
    renderProps();
    void loadImages(els).then(layout);
    layout();
    canvas.focus();
  });
}
