// Draws Nib's items onto a canvas. The context must already map page points
// to pixels (see model.pageMatrix). Text layout here is also used by the PDF
// writer, so line breaks on screen and in the saved file are the same.
import { drawInk } from '../ink/stroke';
import {
  contentSize,
  fillTokens,
  NOTE_SIZE,
  type FontFamily,
  type HeaderFooter,
  type ImageItem,
  type Item,
  type MarkItem,
  type PageEntry,
  type Rect,
  type Rot,
  type ShapeItem,
  type StampItem,
  type TextItem,
  type Watermark,
} from '../model';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// Metric-compatible stacks: Arial = Helvetica, Times New Roman = Times, Courier New = Courier.
const STACKS: Record<FontFamily, string> = {
  sans: 'Arial, Helvetica, "Liberation Sans", Arimo, sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", Tinos, serif',
  mono: '"Courier New", Courier, "Liberation Mono", Cousine, monospace',
};

export function cssFont(font: FontFamily, size: number, bold: boolean, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${STACKS[font]}`;
}

export const FONT_LABEL: Record<FontFamily, string> = { sans: 'Arial / Helvetica', serif: 'Times', mono: 'Courier' };

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function measurer(): OffscreenCanvasRenderingContext2D {
  if (!measureCtx) measureCtx = new OffscreenCanvas(8, 8).getContext('2d')!;
  return measureCtx;
}

export function measure(text: string, font: FontFamily, size: number, bold: boolean, italic: boolean): number {
  const m = measurer();
  // Measure at 100px for precision, then scale.
  m.font = cssFont(font, 100, bold, italic);
  return (m.measureText(text).width * size) / 100;
}

export interface TextLayout {
  lines: string[];
  lineH: number;
  padX: number;
  /** Baseline of the first line, from the top of the content box. */
  base: number;
  /** Width the text needs (longest line + padding). */
  needW: number;
  /** Height the text needs. */
  needH: number;
}

export function layoutText(t: Pick<TextItem, 'text' | 'font' | 'size' | 'bold' | 'italic' | 'valign' | 'wrap'> & { w: number; h: number; rot: Rot }): TextLayout {
  const { w: cw, h: ch } = contentSize(t);
  const padX = Math.max(1.5, t.size * 0.18);
  const lineH = t.size * 1.2;
  const avail = Math.max(t.size, cw - padX * 2);
  const lines: string[] = [];
  for (const para of t.text.split('\n')) {
    if (!t.wrap) {
      lines.push(para);
      continue;
    }
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word;
      if (!cur || measure(next.trimEnd(), t.font, t.size, t.bold, t.italic) <= avail) {
        cur = next;
        continue;
      }
      lines.push(cur.trimEnd());
      cur = word.trimStart();
      // A single word wider than the box: break it by characters.
      while (cur && measure(cur, t.font, t.size, t.bold, t.italic) > avail) {
        let k = cur.length - 1;
        while (k > 1 && measure(cur.slice(0, k), t.font, t.size, t.bold, t.italic) > avail) k--;
        lines.push(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
    lines.push(cur.trimEnd());
  }
  const widest = Math.max(0, ...lines.map((l) => measure(l, t.font, t.size, t.bold, t.italic)));
  const needH = lines.length * lineH + t.size * 0.3;
  let base: number;
  if (t.valign === 'middle' && lines.length === 1) base = ch / 2 + t.size * 0.35;
  else base = t.size * 0.15 + t.size * 0.92;
  return { lines, lineH, padX, base, needW: widest + padX * 2, needH };
}

/** Sets a transform so (0,0) is the top-left of the item's upright content box. */
function withContent(ctx: Ctx, r: Rect & { rot: Rot }, fn: (cw: number, ch: number) => void): void {
  const { w: cw, h: ch } = contentSize(r);
  ctx.save();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.rotate((r.rot * Math.PI) / 2);
  ctx.translate(-cw / 2, -ch / 2);
  fn(cw, ch);
  ctx.restore();
}

export function drawText(ctx: Ctx, t: TextItem): void {
  const lay = layoutText(t);
  withContent(ctx, t, (cw, ch) => {
    if (t.cover) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.font = cssFont(t.font, t.size, t.bold, t.italic);
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'alphabetic';
    lay.lines.forEach((line, i) => ctx.fillText(line, lay.padX, lay.base + i * lay.lineH));
  });
}

/** Path of a tick mark inside a w x h box, in box units (0..1). */
export const CHECK_PATH: [number, number][] = [
  [0.16, 0.54],
  [0.4, 0.78],
  [0.86, 0.22],
];

export function drawMark(ctx: Ctx, m: MarkItem): void {
  const s = Math.min(m.w, m.h);
  const x = m.x + (m.w - s) / 2;
  const y = m.y + (m.h - s) / 2;
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.8, s * 0.14);
  if (m.shape === 'dot') {
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s / 2, s * 0.27, 0, Math.PI * 2);
    ctx.fill();
  } else if (m.shape === 'cross') {
    ctx.beginPath();
    ctx.moveTo(x + s * 0.2, y + s * 0.2);
    ctx.lineTo(x + s * 0.8, y + s * 0.8);
    ctx.moveTo(x + s * 0.8, y + s * 0.2);
    ctx.lineTo(x + s * 0.2, y + s * 0.8);
    ctx.stroke();
  } else {
    ctx.beginPath();
    CHECK_PATH.forEach(([u, v], i) => (i ? ctx.lineTo(x + u * s, y + v * s) : ctx.moveTo(x + u * s, y + v * s)));
    ctx.stroke();
  }
  ctx.restore();
}

export function arrowHead(s: ShapeItem): [number, number][] {
  const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const len = Math.max(6, s.width * 4);
  const spread = 0.42;
  return [
    [s.x2 - len * Math.cos(ang - spread), s.y2 - len * Math.sin(ang - spread)],
    [s.x2, s.y2],
    [s.x2 - len * Math.cos(ang + spread), s.y2 - len * Math.sin(ang + spread)],
  ];
}

export function drawShape(ctx: Ctx, s: ShapeItem): void {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  ctx.beginPath();
  if (s.shape === 'rect') ctx.rect(x, y, w, h);
  else if (s.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    if (s.shape === 'arrow') {
      const [a, b, c] = arrowHead(s);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function stampLayout(s: Pick<StampItem, 'label' | 'sub' | 'w' | 'h' | 'rot'>): { size: number; subSize: number } {
  const { w: cw, h: ch } = contentSize(s);
  const subSize = s.sub ? Math.max(5, ch * 0.2) : 0;
  const room = ch - (s.sub ? subSize * 1.5 : 0);
  const byW = (cw * 0.84) / Math.max(1, measure(s.label, 'sans', 1, true, false));
  return { size: Math.max(5, Math.min(room * 0.62, byW)), subSize };
}

export function drawStamp(ctx: Ctx, s: StampItem): void {
  const lay = stampLayout(s);
  withContent(ctx, s, (cw, ch) => {
    const r = Math.min(cw, ch) * 0.14;
    const bw = Math.max(1, Math.min(cw, ch) * 0.05);
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = bw;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.roundRect(bw / 2, bw / 2, cw - bw, ch - bw, r);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = cssFont('sans', lay.size, true, false);
    const mainBase = s.sub ? ch * 0.5 + lay.size * 0.2 : ch / 2 + lay.size * 0.35;
    ctx.fillText(s.label, cw / 2, mainBase);
    if (s.sub) {
      ctx.font = cssFont('sans', lay.subSize, false, false);
      ctx.fillText(s.sub, cw / 2, mainBase + lay.subSize * 1.45);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
  });
}

// ---------- images ----------

export interface StoredImage {
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
  bitmap: ImageBitmap | null;
}

export const images = new Map<string, StoredImage>();

export function drawImage(ctx: Ctx, it: ImageItem): void {
  const img = images.get(it.image);
  if (!img?.bitmap) return;
  withContent(ctx, it, (cw, ch) => ctx.drawImage(img.bitmap!, 0, 0, cw, ch));
}

export function drawNote(ctx: Ctx, x: number, y: number, color: string): void {
  const s = NOTE_SIZE;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x + s, y + s * 0.72);
  ctx.lineTo(x + s * 0.72, y + s);
  ctx.lineTo(x, y + s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  for (const f of [0.3, 0.5, 0.7]) {
    ctx.beginPath();
    ctx.moveTo(x + s * 0.2, y + s * f);
    ctx.lineTo(x + s * (f === 0.7 ? 0.55 : 0.8), y + s * f);
    ctx.stroke();
  }
  ctx.restore();
}

export interface DrawOptions {
  /** Item ids not to draw (being edited or dragged). */
  hide?: Set<string>;
  /** Show editing aids (redaction marks, links, hand-made fields). */
  aids?: boolean;
}

export function drawItems(ctx: Ctx, items: Item[], opts: DrawOptions = {}): void {
  for (const it of items) {
    if (opts.hide?.has(it.id)) continue;
    switch (it.type) {
      case 'ink':
        drawInk(ctx, it);
        break;
      case 'text':
        drawText(ctx, it);
        break;
      case 'mark':
        drawMark(ctx, it);
        break;
      case 'shape':
        drawShape(ctx, it);
        break;
      case 'stamp':
        drawStamp(ctx, it);
        break;
      case 'image':
        drawImage(ctx, it);
        break;
      case 'note':
        drawNote(ctx, it.x, it.y, it.color);
        break;
      case 'markup':
        ctx.save();
        ctx.fillStyle = it.color;
        for (const r of it.rects) {
          if (it.kind === 'highlight') {
            ctx.globalAlpha = 0.35;
            ctx.fillRect(r.x, r.y, r.w, r.h);
          } else {
            const t = Math.max(0.6, r.h * 0.07);
            ctx.globalAlpha = 1;
            ctx.fillRect(r.x, it.kind === 'underline' ? r.y + r.h - t * 1.5 : r.y + r.h * 0.55 - t / 2, r.w, t);
          }
        }
        ctx.restore();
        break;
      case 'link':
        if (opts.aids) {
          ctx.save();
          ctx.strokeStyle = '#2f3fd6';
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 0.8;
          ctx.strokeRect(it.x, it.y, it.w, it.h);
          ctx.restore();
        }
        break;
      case 'redact':
        ctx.save();
        ctx.fillStyle = 'rgba(196, 30, 45, 0.18)';
        ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.strokeStyle = '#c41e2d';
        ctx.lineWidth = 1;
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        ctx.beginPath();
        ctx.moveTo(it.x, it.y);
        ctx.lineTo(it.x + it.w, it.y + it.h);
        ctx.moveTo(it.x + it.w, it.y);
        ctx.lineTo(it.x, it.y + it.h);
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.restore();
        break;
      case 'field':
        ctx.save();
        ctx.fillStyle = 'rgba(47, 63, 214, 0.08)';
        ctx.strokeStyle = 'rgba(47, 63, 214, 0.7)';
        ctx.lineWidth = 0.8;
        ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        ctx.restore();
        break;
    }
  }
}

/** Placement of header/footer text, in shown (upright) page space. */
export function hfSlots(hf: HeaderFooter, shownW: number, shownH: number): { text: string; x: number; y: number; align: 'left' | 'center' | 'right' }[] {
  const out: { text: string; x: number; y: number; align: 'left' | 'center' | 'right' }[] = [];
  const m = hf.margin;
  const aligns = ['left', 'center', 'right'] as const;
  const xs = [m, shownW / 2, shownW - m];
  hf.header.forEach((t, i) => t && out.push({ text: t, x: xs[i], y: m * 0.6 + hf.size, align: aligns[i] }));
  hf.footer.forEach((t, i) => t && out.push({ text: t, x: xs[i], y: shownH - m * 0.6, align: aligns[i] }));
  return out;
}

/**
 * Draws header/footer and watermark. The context must map *shown* page space
 * (upright, as on screen) to pixels.
 */
export function drawDecor(ctx: Ctx, p: PageEntry, num: number, total: number, file: string, hf: HeaderFooter | null, wm: Watermark | null, shownW: number, shownH: number): void {
  if (wm && wm.text) {
    ctx.save();
    ctx.globalAlpha = wm.opacity;
    ctx.fillStyle = wm.color;
    ctx.font = cssFont('sans', wm.size, true, false);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(shownW / 2, shownH / 2);
    if (wm.diagonal) ctx.rotate(-Math.atan2(shownH, shownW));
    ctx.fillText(wm.text, 0, 0);
    ctx.restore();
  }
  if (hf) {
    ctx.save();
    ctx.fillStyle = hf.color;
    ctx.font = cssFont('sans', hf.size, false, false);
    ctx.textBaseline = 'alphabetic';
    for (const s of hfSlots(hf, shownW, shownH)) {
      ctx.textAlign = s.align;
      ctx.fillText(fillTokens(s.text, num, total, file), s.x, s.y);
    }
    ctx.restore();
  }
  void p;
}
