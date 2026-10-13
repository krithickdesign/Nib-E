// Finds fill-in places in PDFs that have no real form fields: drawn boxes,
// underlines, and small square or round tick boxes (vector, image or glyph).
// Each place gets the font family and size of the label next to it.
import { free, heap, luminance, malloc, mul, objBounds, objMatrix, pdfium, readU32, type Box, type FontFamily, type Mat } from './core';
import { PageText, type PChar } from './text';

export type FieldKind = 'text' | 'check' | 'radio';

export interface DetectedField {
  id: string;
  kind: FieldKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Font for typed answers, taken from the nearest label. */
  font: FontFamily;
  size: number;
  label: string;
  /** For tick boxes: the text right next to it (the option name). */
  option?: string;
  multiline: boolean;
  /** Radio buttons on one row share a group: picking one clears the others. */
  group?: string;
  /** Grey placeholder text sits on this line: cover it when typing. */
  cover?: boolean;
}

interface Cand {
  kind: 'box' | 'toggle' | 'line';
  cover?: boolean;
  /** Painting order on the page; later objects cover earlier ones. */
  order?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'circle' | 'square';
}

const OBJ_PATH = 2;
const OBJ_IMAGE = 3;
const OBJ_FORM = 5;
const SEG_LINETO = 0;
const SEG_BEZIER = 1;
const SEG_MOVETO = 2;

const DEBUG = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NIB_DEBUG;
const TOGGLE_MIN = 5;
const TOGGLE_MAX = 22;
const BOX_SYMBOLS = new Set(['☐', '□', '▢', '◻', '❏', '❐', '❑', '❒', '⬜']);
const CIRCLE_SYMBOLS = new Set(['○', '◯', '⚪', '❍', '◦']);
const SPLITTERS = new Set(['-', '–', '—', '/', '.', ':', 'bis']);

function rgba(get: (o: number, r: number, g: number, b: number, a: number) => boolean, obj: number): [number, number, number, number] {
  const p = malloc(16);
  try {
    if (!get(obj, p, p + 4, p + 8, p + 12)) return [0, 0, 0, 0];
    return readU32(p, 4) as [number, number, number, number];
  } finally {
    free(p);
  }
}

/** Classifies a small bitmap as round or square by comparing corner and edge ink. */
function bitmapShape(bitmap: number): 'circle' | 'square' {
  const m = pdfium();
  const w = m.FPDFBitmap_GetWidth(bitmap);
  const h = m.FPDFBitmap_GetHeight(bitmap);
  const stride = m.FPDFBitmap_GetStride(bitmap);
  const buf = m.FPDFBitmap_GetBuffer(bitmap);
  const fmt = m.FPDFBitmap_GetFormat(bitmap); // 1 gray, 2 BGR, 3 BGRx, 4 BGRA
  if (!w || !h || !buf) return 'square';
  const bpp = fmt === 1 ? 1 : fmt === 2 ? 3 : 4;
  const heapBytes = (pdfium().pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const ink = (x: number, y: number) => {
    const o = buf + y * stride + x * bpp;
    if (bpp === 1) return 1 - heapBytes[o] / 255;
    const a = bpp === 4 ? heapBytes[o + 3] / 255 : 1;
    return (1 - luminance(heapBytes[o + 2], heapBytes[o + 1], heapBytes[o])) * a;
  };
  const region = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        s += ink(x, y);
        n++;
      }
    return n ? s / n : 0;
  };
  const c = Math.max(1, Math.round(Math.min(w, h) * 0.18));
  const corners = (region(0, 0, c, c) + region(w - c, 0, w, c) + region(0, h - c, c, h) + region(w - c, h - c, w, h)) / 4;
  const mx = Math.floor(w / 2 - c / 2);
  const my = Math.floor(h / 2 - c / 2);
  const edges = (region(mx, 0, mx + c, c) + region(mx, h - c, mx + c, h) + region(0, my, c, my + c) + region(w - c, my, w, my + c)) / 4;
  return edges > 0.05 && corners < edges * 0.55 ? 'circle' : 'square';
}

/**
 * Renders a small region of the page and reports where visible ink is,
 * ignoring the box's own fill. Text that is hidden, clipped or covered
 * produces no ink, so this is more reliable than reading the text layer.
 */
function inkSpans(page: number, r: { x: number; y: number; w: number; h: number }): [number, number][] {
  const m = pdfium();
  const s = 2;
  const W = Math.max(1, Math.round(r.w * s));
  const Hh = Math.max(1, Math.round(r.h * s));
  const bmp = m.FPDFBitmap_CreateEx(W, Hh, 4, 0, 0);
  if (!bmp) return [];
  const mat = malloc(24);
  const clip = malloc(16);
  try {
    m.FPDFBitmap_FillRect(bmp, 0, 0, W, Hh, 0xffffffff);
    // Pages are loaded without /Rotate, so render space = Nib page points.
    new Float32Array(heap().buffer, mat, 6).set([s, 0, 0, s, -r.x * s, -r.y * s]);
    new Float32Array(heap().buffer, clip, 4).set([0, 0, W, Hh]);
    m.FPDF_RenderPageBitmapWithMatrix(bmp, page, mat, clip, 0);
    const buf = m.FPDFBitmap_GetBuffer(bmp);
    const stride = m.FPDFBitmap_GetStride(bmp);
    const px = heap();
    const lum = (x: number, y: number) => {
      const o = buf + y * stride + x * 4;
      return luminance(px[o + 2], px[o + 1], px[o]);
    };
    // Reference colour: the most common luminance inside the box (its fill).
    const hist = new Map<number, number>();
    const inset = Math.min(3, Math.floor(Hh / 4));
    for (let y = inset; y < Hh - inset; y += 2)
      for (let x = inset; x < W - inset; x += 2) {
        const k = Math.round(lum(x, y) * 40);
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
    let ref = 1;
    let best = -1;
    for (const [k, n] of hist) if (n > best) [best, ref] = [n, k / 40];
    const cols: boolean[] = [];
    for (let x = 0; x < W; x++) {
      let ink = 0;
      for (let y = inset; y < Hh - inset; y++) if (Math.abs(lum(x, y) - ref) > 0.3) ink++;
      cols.push(ink >= 1);
    }
    const spans: [number, number][] = [];
    for (let x = inset; x < W - inset; x++) {
      if (!cols[x]) continue;
      let e = x;
      while (e + 1 < W - inset && cols[e + 1]) e++;
      spans.push([r.x + x / s, r.x + (e + 1) / s]);
      x = e;
    }
    return spans;
  } finally {
    free(mat);
    free(clip);
    m.FPDFBitmap_Destroy(bmp);
  }
}

const ANNOT_WIDGET = 20;

/** Rectangles of existing form fields on the page, in page points. */
function widgetRects(page: number, box: Box): Cand[] {
  const m = pdfium();
  const out: Cand[] = [];
  const n = m.FPDFPage_GetAnnotCount(page);
  const r = malloc(16);
  try {
    for (let i = 0; i < n; i++) {
      const a = m.FPDFPage_GetAnnot(page, i);
      if (!a) continue;
      try {
        if (m.FPDFAnnot_GetSubtype(a) !== ANNOT_WIDGET || !m.FPDFAnnot_GetRect(a, r)) continue;
        const [left, top, right, bottom] = new Float32Array(heap().buffer, r, 4);
        const l = Math.min(left, right);
        const t = Math.max(top, bottom);
        out.push({ kind: 'box', x: l - box.left, y: box.top - t, w: Math.abs(right - left), h: Math.abs(top - bottom) });
      } finally {
        m.FPDFPage_CloseAnnot(a);
      }
    }
  } finally {
    free(r);
  }
  return out;
}

function overlap(a: Cand, b: Cand): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / Math.min(a.w * a.h, b.w * b.h || 1);
}

function contains(outer: Cand, inner: Cand, pad = 0.5): boolean {
  return inner.x >= outer.x - pad && inner.y >= outer.y - pad && inner.x + inner.w <= outer.x + outer.w + pad && inner.y + inner.h <= outer.y + outer.h + pad;
}

/** Walks every drawn object on a page, including those nested in form XObjects. */
function collect(page: number, box: Box, docPtr: number): { cands: Cand[]; vlines: Cand[]; order: Map<number, number> } {
  const m = pdfium();
  const cands: Cand[] = [];
  const vlines: Cand[] = [];
  const order = new Map<number, number>();
  let seq = 0;
  const toModel = (l: number, b: number, r: number, t: number) => ({ x: l - box.left, y: box.top - t, w: r - l, h: t - b });
  const dm = malloc(8);

  const visit = (obj: number, parent: Mat | null, depth: number) => {
    const type = m.FPDFPageObj_GetType(obj);
    const at = seq++;
    order.set(obj, at);
    if (type === OBJ_FORM) {
      if (depth > 6) return;
      const fm = parent ? mul(objMatrix(obj), parent) : objMatrix(obj);
      const n = m.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < n; k++) visit(m.FPDFFormObj_GetObject(obj, k), fm, depth + 1);
      return;
    }
    if (type !== OBJ_PATH && type !== OBJ_IMAGE) return;
    const [l, b, r, t] = objBounds(obj, parent);
    const g = toModel(l, b, r, t);
    if (!(g.w > 0) && !(g.h > 0)) return;

    if (type === OBJ_IMAGE) {
      if (g.w >= TOGGLE_MIN && g.w <= TOGGLE_MAX && Math.abs(g.w - g.h) <= 2.5) {
        let shape: 'circle' | 'square' = 'square';
        // The rendered bitmap has the image's mask applied (transparent corners on round buttons).
        const bmp = m.FPDFImageObj_GetRenderedBitmap(docPtr, page, obj) || m.FPDFImageObj_GetBitmap(obj);
        if (bmp) {
          shape = bitmapShape(bmp);
          m.FPDFBitmap_Destroy(bmp);
        }
        cands.push({ kind: 'toggle', ...g, shape, order: at });
      }
      return;
    }

    // Path
    m.FPDFPath_GetDrawMode(obj, dm, dm + 4);
    const [fillMode, stroke] = readU32(dm, 2);
    const fill = rgba(m.FPDFPageObj_GetFillColor, obj);
    const line = rgba(m.FPDFPageObj_GetStrokeColor, obj);
    const fillLum = luminance(fill[0], fill[1], fill[2]);
    const fillVisible = fillMode !== 0 && fill[3] > 20 && fillLum < 0.965;
    const strokeVisible = !!stroke && line[3] > 20 && luminance(line[0], line[1], line[2]) < 0.9;
    if (!fillVisible && !strokeVisible) return;

    const n = m.FPDFPath_CountSegments(obj);
    let moves = 0;
    let lines = 0;
    let curves = 0;
    for (let s = 0; s < n; s++) {
      const t2 = m.FPDFPathSegment_GetType(m.FPDFPath_GetPathSegment(obj, s));
      if (t2 === SEG_MOVETO) moves++;
      else if (t2 === SEG_LINETO) lines++;
      else if (t2 === SEG_BEZIER) curves++;
    }

    // Thin horizontal or vertical strokes and hairline rectangles act as lines.
    if (g.h <= 2.2 && g.w >= 40 && (strokeVisible || (fillVisible && fillLum < 0.75))) {
      if (moves <= 1 && curves === 0) cands.push({ kind: 'line', ...g, order: at });
      return;
    }
    if (g.w <= 2.2 && g.h >= 10) {
      vlines.push({ kind: 'line', ...g });
      return;
    }
    if (moves !== 1) return;
    const small = g.w >= TOGGLE_MIN && g.w <= TOGGLE_MAX && g.h >= TOGGLE_MIN && g.h <= TOGGLE_MAX && Math.abs(g.w - g.h) <= 2.5;
    if (curves >= 2 && small) {
      cands.push({ kind: 'toggle', ...g, shape: 'circle', order: at });
      return;
    }
    if (curves > 0 || lines < 3 || lines > 5) return;
    if (small && (strokeVisible || fillVisible)) {
      cands.push({ kind: 'toggle', ...g, shape: 'square', order: at });
      return;
    }
    // A light fill or a visible border, sized like an answer box.
    const lightFill = fillVisible && fillLum > 0.55;
    if ((lightFill || (strokeVisible && !fillVisible) || (strokeVisible && fillLum > 0.9)) && g.w >= 18 && g.h >= 7 && g.h <= 400) {
      cands.push({ kind: 'box', ...g, order: at });
    }
  };

  try {
    const n = m.FPDFPage_CountObjects(page);
    for (let k = 0; k < n; k++) visit(m.FPDFPage_GetObject(page, k), null, 0);
  } finally {
    free(dm);
  }
  return { cands, vlines, order };
}

function dedupe(list: Cand[], threshold: number): Cand[] {
  const out: Cand[] = [];
  for (const c of list) {
    const twin = out.find((o) => o.kind === c.kind && overlap(o, c) > threshold && Math.abs(o.w * o.h - c.w * c.h) / Math.max(o.w * o.h, c.w * c.h) < 0.35);
    if (twin) {
      if (c.shape === 'circle') twin.shape = 'circle';
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

interface Label {
  font: FontFamily;
  size: number;
  text: string;
}

/** Text right of a tick box on the same row, e.g. the option name "Herr". */
function optionText(t: PageText, f: { x: number; y: number; w: number; h: number }, nextX: number): string {
  const midY = f.y + f.h / 2;
  const row = t.chars
    .filter((c) => !c.faint && c.x0 >= f.x + f.w - 1 && c.x0 < nextX - 2 && c.x0 - (f.x + f.w) < 260 && Math.abs((c.y0 + c.y1) / 2 - midY) <= Math.max(f.h / 2, (c.y1 - c.y0) * 0.5))
    .sort((a, b) => a.x0 - b.x0);
  let out = '';
  let last: PChar | null = null;
  for (const c of row) {
    if (last && c.x0 - last.x1 > c.size * 1.2) break;
    out += c.ch;
    last = c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function findLabel(t: PageText, f: { x: number; y: number; w: number; h: number }, bodySize: number): Label {
  const chars = t.chars.filter((c) => !c.faint && !/\s/.test(c.ch));
  const midY = f.y + f.h / 2;
  // Same row, to the left.
  const row = chars.filter((c) => {
    const cy = (c.y0 + c.y1) / 2;
    return c.x1 <= f.x + 1.5 && f.x - c.x1 < 320 && Math.abs(cy - midY) <= Math.max(f.h / 2, (c.y1 - c.y0) * 0.6);
  });
  let pick: PChar | undefined;
  let words: PChar[] = [];
  if (row.length) {
    pick = row.reduce((a, b) => (b.x1 > a.x1 ? b : a));
    words = row;
  } else {
    // Directly above, overlapping horizontally.
    const above = chars.filter((c) => c.y1 <= f.y + 1.5 && f.y - c.y1 < 28 && c.x1 > f.x - 10 && c.x0 < f.x + f.w);
    if (above.length) {
      const nearestY = Math.max(...above.map((c) => c.y1));
      const near = above.filter((c) => Math.abs(c.y1 - nearestY) < 2);
      pick = near.reduce((a, b) => (b.x0 < a.x0 ? b : a));
      // The whole line, so the label reads as the full question.
      words = chars.filter((c) => Math.abs(c.y1 - nearestY) < 2 && c.x0 < f.x + f.w + 300);
    }
  }
  if (!pick) {
    // Signature and date lines are often labelled underneath.
    const below = chars.filter((c) => c.y0 >= f.y + f.h - 2 && c.y0 - (f.y + f.h) < 14 && c.x1 > f.x && c.x0 < f.x + f.w);
    if (!below.length) return { font: 'sans', size: bodySize, text: '' };
    const top = Math.min(...below.map((c) => c.y0));
    const line = below.filter((c) => Math.abs(c.y0 - top) < 2).sort((a, b) => a.x0 - b.x0);
    const text = line.reduce((s, c, k) => s + (k && c.x0 - line[k - 1].x1 > c.size * 0.1 ? ' ' : '') + c.ch, '').trim();
    return { font: t.font(line[0]).family, size: bodySize, text };
  }
  const info = t.font(pick);
  // The main label is usually the largest text on its line; notes in brackets are smaller.
  const lineChars = words.filter((c) => Math.abs((c.y0 + c.y1) / 2 - (pick!.y0 + pick!.y1) / 2) < (pick!.y1 - pick!.y0) * 0.5);
  const biggest = Math.max(pick.size, ...lineChars.map((c) => c.size));
  const size = Math.round(biggest * 2) / 2 || bodySize;
  const text = words
    .sort((a, b) => a.x0 - b.x0)
    .reduce((s, c, k, arr) => s + (k && c.x0 - arr[k - 1].x1 > c.size * 0.1 ? ' ' : '') + c.ch, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { font: info.family, size, text };
}

function median(values: number[]): number {
  if (!values.length) return 10;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Detects fill-in places on one page of a raw document. Returns [] if none. */
export function detectFields(doc: number, index: number, idPrefix: string): DetectedField[] {
  const m = pdfium();
  // Load without /Rotate: every coordinate below is in unrotated page space.
  const page = m.EPDF_LoadPageNormalized(doc, index, 0);
  if (!page) return [];
  let text: PageText | null = null;
  try {
    const H = m.FPDF_GetPageHeightF(page);
    text = new PageText(page, H);
    const box = text.box;
    const pageW = box.right - box.left;
    const pageH = box.top - box.bottom;
    const { cands, vlines } = collect(page, box, doc);
    // Places that already have a real form field are not detected again.
    const widgets = widgetRects(page, box);
    const bodySize = median(text.chars.filter((c) => !c.faint && !/\s/.test(c.ch)).map((c) => c.size));

    // Glyph tick boxes (☐ ○ and Wingdings equivalents).
    for (const c of text.chars) {
      const sq = BOX_SYMBOLS.has(c.ch);
      const ci = CIRCLE_SYMBOLS.has(c.ch);
      let wing = false;
      if (!sq && !ci) {
        const code = c.ch.codePointAt(0)!;
        if (code >= 0xf000 && code <= 0xf0ff) {
          const name = text.font(c).name;
          wing = /wingding|dingbat/i.test(name) && [0x6f, 0x71, 0x72, 0xa8, 0xa1, 0x6d, 0x6e].includes(code & 0xff);
        }
      }
      if (sq || ci || wing) {
        const s = Math.min(c.x1 - c.x0, c.y1 - c.y0);
        const cx = (c.x0 + c.x1) / 2;
        const cy = (c.y0 + c.y1) / 2;
        const size = Math.max(TOGGLE_MIN, s * 0.8);
        cands.push({ kind: 'toggle', x: cx - size / 2, y: cy - size / 2, w: size, h: size, shape: ci ? 'circle' : 'square' });
      }
    }

    let boxes = dedupe(cands.filter((c) => c.kind === 'box' && c.w * c.h < pageW * pageH * 0.35), 0.9);
    let toggles = dedupe(cands.filter((c) => c.kind === 'toggle'), 0.5);
    let lines = dedupe(cands.filter((c) => c.kind === 'line'), 0.9);

    // Frames around other boxes or around a tick box are decoration, not fields.
    boxes = boxes.filter((b) => {
      const inner = boxes.filter((o) => o !== b && contains(b, o)).length;
      const innerToggles = toggles.filter((t) => contains(b, t)).length;
      return inner === 0 && innerToggles === 0;
    });
    // Tick boxes drawn as a square with a separate image or glyph on top.
    toggles = toggles.filter((t, k) => !toggles.some((o, j) => j < k && Math.hypot(o.x + o.w / 2 - (t.x + t.w / 2), o.y + o.h / 2 - (t.y + t.h / 2)) < 3));

    // Boxes that already show something are filled in or are labels. A lone
    // dash or slash splits the box into two answers (e.g. a date range).
    const words = text.chars.filter((c) => !c.faint && !/\s/.test(c.ch));
    const split: Cand[] = [];
    for (const b of boxes) {
      const spans = inkSpans(page, b);
      if (DEBUG) console.log('box', b.x.toFixed(0), b.y.toFixed(0), b.w.toFixed(0), b.h.toFixed(0), 'ink', spans.map((sp) => sp.map((v) => v.toFixed(1)).join('-')).join(' '));
      if (!spans.length) {
        split.push(b);
        continue;
      }
      const sx0 = spans[0][0];
      const sx1 = spans[spans.length - 1][1];
      const inkW = sx1 - sx0;
      const visible = words.filter((c) => c.x0 < sx1 && c.x1 > sx0 && (c.y0 + c.y1) / 2 > b.y && (c.y0 + c.y1) / 2 < b.y + b.h);
      const str = visible.map((c) => c.ch).join('');
      if (inkW <= Math.max(10, b.h * 0.6) && (SPLITTERS.has(str) || !str)) {
        if (sx0 - b.x >= 15) split.push({ ...b, w: sx0 - b.x - 3 });
        if (b.x + b.w - sx1 >= 15) split.push({ ...b, x: sx1 + 3, w: b.x + b.w - sx1 - 3 });
      }
    }
    boxes = split;

    // Underlines: skip ones with text on them, box edges, and table rules.
    const fromLines: Cand[] = [];
    for (const l of lines) {
      if (boxes.some((b) => l.x >= b.x - 2 && l.x + l.w <= b.x + b.w + 2 && (Math.abs(l.y - b.y) < 2.5 || Math.abs(l.y - (b.y + b.h)) < 2.5))) continue;
      if (vlines.some((v) => v.x > l.x + 3 && v.x < l.x + l.w - 3 && v.y < l.y + 1 && v.y + v.h > l.y - 1)) continue;
      const h = Math.max(12, bodySize * 1.6);
      const area = { x: l.x, y: l.y - h, w: l.w, h };
      // Text sitting on the line (centre above it); the caption under the line doesn't count.
      const onTop = words.filter((c) => {
        const cy = (c.y0 + c.y1) / 2;
        return c.x1 > area.x + 2 && c.x0 < area.x + area.w - 2 && cy > area.y && cy < l.y - 0.5;
      });
      // Grey text on a line is a placeholder ("Click here to enter text"): still a field.
      // It sits right on the line; grey text higher up is a subtitle above a heading rule.
      const placeholder = onTop.length > 0 && onTop.every((c) => c.lum > 0.35) && Math.max(...onTop.map((c) => c.y1)) >= l.y - 6;
      if (onTop.length && !placeholder) continue;
      // A bare rule is only a fill-in line with a label: left of it, on it (placeholder),
      // or a short caption under it. Footnote rules and heading underlines have none.
      const leftLabel = words.some((c) => c.x1 <= l.x + 2 && l.x - c.x1 < 200 && Math.abs((c.y0 + c.y1) / 2 - (l.y - h / 2)) < h * 0.7);
      const under = words.filter((c) => c.y0 >= l.y - 1 && c.y0 - l.y < 14 && c.x1 > l.x && c.x0 < l.x + l.w);
      let caption = false;
      if (under.length) {
        // The whole caption line must be short and not run far past the rule (a footnote does).
        const top = Math.min(...under.map((c) => c.y0));
        const line = words.filter((c) => Math.abs(c.y0 - top) < 2);
        const right = Math.max(...line.map((c) => c.x1));
        caption = line.length <= 60 && right <= l.x + l.w * 1.3 + 20;
      }
      if (!placeholder && !leftLabel && !caption) continue;
      fromLines.push({ kind: 'box', ...area, cover: placeholder || undefined });
    }
    lines = [];

    const free = (c: Cand) => !widgets.some((w) => overlap(c, w) > 0.3);
    boxes = boxes.filter(free);
    toggles = toggles.filter(free);
    fromLines.splice(0, fromLines.length, ...fromLines.filter(free));

    const all: (Cand & { fkind: FieldKind })[] = [
      ...boxes.map((b) => ({ ...b, fkind: 'text' as const })),
      ...fromLines.map((b) => ({ ...b, fkind: 'text' as const })),
      ...toggles.map((t) => ({ ...t, fkind: (t.shape === 'circle' ? 'radio' : 'check') as FieldKind })),
    ];
    // Reading order: top to bottom by row, then left to right.
    all.sort((a, b) => (Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < 4 ? a.x - b.x : a.y - b.y));

    let fields: DetectedField[] = all.map((c) => {
      const label = findLabel(text!, c, bodySize);
      const size = c.fkind === 'text' ? Math.min(label.size, Math.max(6, c.h * 0.78)) : label.size;
      return {
        id: '',
        kind: c.fkind,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        font: label.font,
        size,
        label: label.text,
        multiline: c.fkind === 'text' && c.h >= size * 2.6,
        cover: c.cover,
      };
    });

    // Option names for tick boxes: the text to their right, up to the next tick box.
    for (const f of fields) {
      if (f.kind === 'text') continue;
      const next = fields.filter((o) => o !== f && o.kind !== 'text' && Math.abs(o.y - f.y) < 4 && o.x > f.x).reduce((a, o) => Math.min(a, o.x), Infinity);
      f.option = optionText(text!, f, next);
    }

    // Tick boxes on one row answer one question: they share the leftmost one's label.
    const toggleRows = fields.filter((f) => f.kind !== 'text').sort((a, b) => a.y - b.y || a.x - b.x);
    let rowStart: DetectedField | null = null;
    for (const f of toggleRows) {
      if (!rowStart || Math.abs(f.y + f.h / 2 - (rowStart.y + rowStart.h / 2)) > 4) rowStart = f;
      else f.label = rowStart.label;
    }

    // Table cells: an empty-labelled box right under another box of the same
    // column takes that box's label (the column header).
    const byTop = [...fields].sort((a, b) => a.y - b.y);
    for (const f of byTop) {
      if (f.kind !== 'text' || f.label) continue;
      const above = byTop.find((o) => o !== f && o.kind === 'text' && o.label && Math.abs(o.x - f.x) < 2.5 && Math.abs(o.w - f.w) < 3 && f.y - (o.y + o.h) > -1 && f.y - (o.y + o.h) < 8);
      if (above) {
        f.label = above.label;
        f.font = above.font;
        f.size = above.size;
      }
    }
    // Without any label or option text, a box is most likely decoration.
    fields = fields.filter((f) => (f.kind === 'text' ? !!f.label : !!(f.option || f.label)));
    fields.forEach((f, k) => (f.id = `${idPrefix}${k}`));

    // Radio buttons on the same row form one group.
    let g = 0;
    const radios = fields.filter((f) => f.kind === 'radio').sort((a, b) => a.y - b.y || a.x - b.x);
    let prev: DetectedField | null = null;
    for (const r of radios) {
      if (!prev || Math.abs(r.y + r.h / 2 - (prev.y + prev.h / 2)) > 4 || r.x - prev.x > 260) g++;
      r.group = `${idPrefix}g${g}`;
      prev = r;
    }
    return fields;
  } finally {
    text?.close();
    m.FPDF_ClosePage(page);
  }
}

