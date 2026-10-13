// Page rendering. PDFium renders on the main thread, one page per task, so
// the queue yields between pages to keep pen input smooth.
import { templateLines, TEMPLATE_RGB, totalRot, type PageEntry } from '../model';
import { engine } from '../pdf/pdfium';
import { store } from '../store';

export const PT_TO_PX = 96 / 72;
const MAX_PIXELS = 14_000_000;

export interface RenderJob {
  id: string; // replaces any queued job with the same id
  page: PageEntry;
  scale: number; // device pixels per point
  priority: number; // lower runs first
  done(img: ImageData | null, scale: number): void;
}

/** Identity of a page's bitmap: which source page, how it is turned, form values revision. */
export function bitmapKey(p: PageEntry): string {
  return p.src === null ? `blank:${p.template}:${p.w}x${p.h}:${totalRot(p)}` : `${p.src}:${p.index}:${totalRot(p)}:${formRevision(p.src)}`;
}

const formRevisions = new Map<string, number>();
export function formRevision(src: string): number {
  return formRevisions.get(src) ?? 0;
}
export function bumpFormRevision(src: string): void {
  formRevisions.set(src, formRevision(src) + 1);
}

function clampScale(p: PageEntry, scale: number): number {
  const px = p.w * p.h * scale * scale;
  return px > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (p.w * p.h)) : scale;
}

function renderBlank(p: PageEntry, scale: number): ImageData {
  const rot = totalRot(p);
  const sw = rot % 2 ? p.h : p.w;
  const sh = rot % 2 ? p.w : p.h;
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  const lines = templateLines(p.template, p.w, p.h);
  if (lines.length) {
    // Same mapping as model.pageMatrix, inlined to avoid a circular import.
    const s = scale;
    const W = p.w, H = p.h;
    const m: [number, number, number, number, number, number] =
      rot === 1 ? [0, s, -s, 0, H * s, 0] : rot === 2 ? [-s, 0, 0, -s, W * s, H * s] : rot === 3 ? [0, -s, s, 0, 0, W * s] : [s, 0, 0, s, 0, 0];
    ctx.setTransform(...m);
    ctx.strokeStyle = `rgb(${TEMPLATE_RGB.join(',')})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of lines) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, c.width, c.height);
}

function renderSource(p: PageEntry, scale: number): ImageData | null {
  const src = p.src ? store.doc?.sources.get(p.src) : undefined;
  if (!src) return null;
  const pageObj = src.doc.pages[p.index];
  let out: ImageData | null = null;
  // The engine resolves synchronously for direct (main thread) rendering.
  engine()
    .renderPageRaw(src.doc, pageObj, { scaleFactor: scale, dpr: 1, rotation: totalRot(p), withAnnotations: true, withForms: true })
    .wait(
      (img) => {
        out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
      },
      () => {
        out = null;
      },
    );
  return out;
}

const queue = new Map<string, RenderJob>();
let running = false;

export function requestRender(job: RenderJob): void {
  queue.set(job.id, job);
  if (!running) {
    running = true;
    setTimeout(pump, 0);
  }
}

export function cancelRender(id: string): void {
  queue.delete(id);
}

function pump(): void {
  let next: RenderJob | null = null;
  for (const j of queue.values()) if (!next || j.priority < next.priority) next = j;
  if (!next) {
    running = false;
    return;
  }
  queue.delete(next.id);
  const scale = clampScale(next.page, next.scale);
  let img: ImageData | null = null;
  try {
    img = next.page.src === null ? renderBlank(next.page, scale) : renderSource(next.page, scale);
  } catch (e) {
    console.error('render failed', e);
  }
  next.done(img, scale);
  setTimeout(pump, 0);
}
