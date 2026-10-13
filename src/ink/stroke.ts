// Stroke geometry. The same outline function feeds the screen and the saved
// PDF, so ink looks identical in Nib and in other PDF readers.
import { getStroke } from 'perfect-freehand';
import type { InkItem } from '../model';

export const HIGHLIGHT_ALPHA = 0.32;

export const PEN_COLORS = ['#1b1f2e', '#2f3fd6', '#d62f3f', '#0f8a5f'];
export const HIGHLIGHT_COLORS = ['#ffd84a', '#7ee08a', '#ff8fc8', '#7cc7ff'];
export const PEN_SIZES = [1.2, 2, 3.4, 6];
export const HIGHLIGHT_SIZES = [9, 14, 22];

type StrokeLike = Pick<InkItem, 'kind' | 'size' | 'sim' | 'pts' | 'feel'>;

/**
 * How much the pen smooths what you write.
 *  - precise:  follows the pen tip closely; only sensor jitter is removed (handwriting)
 *  - balanced: light smoothing, keeps the corners of letters (default)
 *  - smooth:   strong smoothing for long lines and diagrams (the v0.3 feel)
 * Smoothing happens once, on the pointer positions (Smoother). The outline step
 * below adds only a little edge smoothing and almost no lag (streamline).
 */
export type PenFeel = 'precise' | 'balanced' | 'smooth';

interface FeelSpec {
  /** One Euro filter: cutoff at rest (Hz) and speed coefficient, for pen and for mouse/finger. */
  pen: [number, number];
  other: [number, number];
  /** perfect-freehand options. */
  smoothing: number;
  streamline: number;
}

export const FEELS: Record<PenFeel, FeelSpec> = {
  precise: { pen: [9, 0.06], other: [6, 0.05], smoothing: 0.4, streamline: 0.05 },
  balanced: { pen: [5, 0.045], other: [4.5, 0.04], smoothing: 0.5, streamline: 0.14 },
  smooth: { pen: [2.2, 0.025], other: [1.4, 0.018], smoothing: 0.62, streamline: 0.32 },
};

/** Strokes saved before v0.4 have no feel stored; they were drawn with "smooth". */
function feelOf(s: { feel?: PenFeel }): FeelSpec {
  return FEELS[s.feel ?? 'smooth'] ?? FEELS.smooth;
}

function options(s: StrokeLike, last: boolean) {
  const f = feelOf(s);
  if (s.kind === 'highlighter') {
    return { size: s.size, thinning: 0, smoothing: 0.7, streamline: Math.max(0.2, f.streamline), simulatePressure: false, last };
  }
  // Mouse and finger input has no pressure: draw it with even width.
  return {
    size: s.size,
    thinning: s.sim ? 0 : 0.55,
    smoothing: f.smoothing,
    streamline: f.streamline,
    simulatePressure: false,
    last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  };
}

export function outline(s: StrokeLike, last = true): number[][] {
  const pts = s.kind === 'highlighter' || s.sim ? s.pts.map((p) => [p[0], p[1], 0.5]) : s.pts;
  return getStroke(pts, options(s, last));
}

const pathCache = new WeakMap<object, Path2D>();

function toPath(poly: number[][]): Path2D {
  const path = new Path2D();
  if (!poly.length) return path;
  // Quadratic curves through midpoints give a smooth edge without corners.
  path.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length - 1; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const lastPt = poly[poly.length - 1];
  path.lineTo(lastPt[0], lastPt[1]);
  path.closePath();
  return path;
}

export function strokePath(s: InkItem): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = toPath(outline(s));
    pathCache.set(s, p);
  }
  return p;
}

export function drawInk(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: InkItem): void {
  ctx.globalAlpha = s.kind === 'highlighter' ? HIGHLIGHT_ALPHA : 1;
  ctx.fillStyle = s.color;
  ctx.fill(strokePath(s));
  ctx.globalAlpha = 1;
}

export function drawLive(ctx: CanvasRenderingContext2D, s: StrokeLike & { color: string }): void {
  ctx.globalAlpha = s.kind === 'highlighter' ? HIGHLIGHT_ALPHA : 1;
  ctx.fillStyle = s.color;
  ctx.fill(toPath(outline(s, false)));
  ctx.globalAlpha = 1;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

/** True when a circle of radius r at (x, y) touches the stroke. */
export function inkHits(s: InkItem, x: number, y: number, r: number): boolean {
  const reach = r + s.size / 2;
  const r2 = reach * reach;
  const p = s.pts;
  if (p.length === 1) return (p[0][0] - x) ** 2 + (p[0][1] - y) ** 2 <= r2;
  for (let i = 1; i < p.length; i++) {
    if (segDist2(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r2) return true;
  }
  return false;
}

export function segmentHits(ax: number, ay: number, bx: number, by: number, x: number, y: number, r: number): boolean {
  return segDist2(x, y, ax, ay, bx, by) <= r * r;
}

/** Thin out points for the PDF ink list (the outline keeps full detail). */
export function decimate<T>(pts: T[], max = 400): T[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------- input smoothing ----------

class LowPass {
  private y: number | null = null;
  filter(x: number, a: number): number {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
  get value(): number | null {
    return this.y;
  }
}

/**
 * One Euro filter (Casiez et al. 2012): strong smoothing when the pointer
 * moves slowly (removes hand and sensor jitter), little smoothing when it moves
 * fast (no lag on quick strokes). Works in screen pixels.
 */
class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;
  constructor(private minCutoff: number, private beta: number, private dCutoff = 1) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(v: number, tMs: number): number {
    const dt = this.lastT === null ? 1 / 120 : Math.max(1 / 1000, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const prev = this.x.value;
    const d = prev === null ? 0 : (v - prev) / dt;
    const ed = this.dx.filter(d, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(v, this.alpha(cutoff, dt));
  }
}

export class Smoother {
  private fx: OneEuro;
  private fy: OneEuro;
  private fp = new LowPass();

  constructor(pen: boolean, feel: PenFeel = 'balanced') {
    // Pens are precise but report fine jitter; mice and fingers are coarser.
    const [minCutoff, beta] = FEELS[feel][pen ? 'pen' : 'other'];
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }

  push(x: number, y: number, pressure: number, tMs: number): [number, number, number] {
    return [this.fx.filter(x, tMs), this.fy.filter(y, tMs), this.fp.filter(pressure, 0.35)];
  }
}
