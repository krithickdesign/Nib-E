// "Edit text": finds a line of the PDF's own text and reads how it looks
// (font, size, colour, alignment), so Nib-E can replace it with new text that
// looks the same. Saving removes the old characters (see export.ts) and writes
// the new ones.
import { pdfium, type Box } from './core';
import { PageText, type PChar, type Rect } from './text';
import { renderPage } from './raster';
import type { FontId } from '../fonts';

export interface FoundLine {
  /** Characters of the line, left to right (spaces included). */
  chars: PChar[];
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  color: string;
  pdfFont: string;
  /** Closest font Nib-E has. */
  font: FontId;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Embedded font file of the first character (for an exact on-screen preview). */
  fontData: Uint8Array | null;
  /** Characters this page already draws in the same font (the font surely has them). */
  glyphs: string;
  /** Problem that makes the line unsuitable, shown to the person. */
  problem?: string;
}

const isSpace = (c: PChar) => /\s/.test(c.ch);
const cy = (c: PChar) => (c.y0 + c.y1) / 2;

/** All lines of a page: characters grouped by baseline band, left to right, split at wide gaps. */
export function pageLines(chars: PChar[]): PChar[][] {
  const ink = chars.filter((c) => !isSpace(c) && c.x1 > c.x0);
  // Sort by vertical centre, then group characters whose centres sit inside each other's band.
  const sorted = [...ink].sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
  const bands: PChar[][] = [];
  for (const c of sorted) {
    const band = bands[bands.length - 1];
    if (band) {
      const ref = band[0];
      const h = Math.max(ref.y1 - ref.y0, 1);
      if (Math.abs(cy(c) - cy(ref)) < h * 0.35 && Math.abs(c.size - ref.size) < Math.max(ref.size, c.size) * 0.45) {
        band.push(c);
        continue;
      }
    }
    bands.push([c]);
  }
  const lines: PChar[][] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x0 - b.x0);
    let cur: PChar[] = [];
    for (const c of band) {
      const last = cur[cur.length - 1];
      if (last && c.x0 - last.x1 > Math.max(last.size, c.size) * 1.6) {
        lines.push(cur);
        cur = [];
      }
      cur.push(c);
    }
    if (cur.length) lines.push(cur);
  }
  return lines;
}

function lineText(line: PChar[], all: PChar[]): string {
  // Keep real space characters between the glyphs; add one where a wide gap has none.
  let out = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (k) {
      const prev = line[k - 1];
      const lo = Math.min(prev.i, c.i);
      const hi = Math.max(prev.i, c.i);
      const hasSpace = all.some((s) => s.i > lo && s.i < hi && s.ch === ' ');
      if (hasSpace || c.x0 - prev.x1 > Math.min(prev.size, c.size) * 0.18) out += ' ';
    }
    out += c.ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function guessAlign(line: PChar[], lines: PChar[][], pageW: number): 'left' | 'center' | 'right' {
  const x0 = line[0].x0;
  const x1 = line[line.length - 1].x1;
  const top = Math.min(...line.map((c) => c.y0));
  const bottom = Math.max(...line.map((c) => c.y1));
  const h = bottom - top;
  const size = line[0].size;
  const near = lines.filter((l) => {
    if (l === line) return false;
    const t = Math.min(...l.map((c) => c.y0));
    const b = Math.max(...l.map((c) => c.y1));
    const lx0 = l[0].x0;
    const lx1 = l[l.length - 1].x1;
    const overlap = Math.min(x1, lx1) - Math.max(x0, lx0);
    const gap = t > bottom ? t - bottom : top - b;
    return gap < h * 1.6 && overlap > -size && Math.abs(l[0].size - size) < size * 0.3;
  });
  const tol = Math.max(1.5, size * 0.2);
  if (near.length) {
    const left = near.some((l) => Math.abs(l[0].x0 - x0) < tol);
    const right = near.some((l) => Math.abs(l[l.length - 1].x1 - x1) < tol);
    const centre = near.some((l) => Math.abs((l[0].x0 + l[l.length - 1].x1) / 2 - (x0 + x1) / 2) < tol);
    if (left) return 'left';
    if (right) return 'right';
    if (centre) return 'center';
    return 'left';
  }
  // A line on its own: centred on the page if both margins match.
  const lm = x0;
  const rm = pageW - x1;
  if (Math.abs(lm - rm) < Math.max(6, size * 0.6) && lm > size * 2) return 'center';
  return 'left';
}

/** Closest font Nib-E has for a font name found in the PDF. */
export function closestFont(name: string, family: 'sans' | 'serif' | 'mono'): FontId {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.includes('inter')) return 'inter';
  if (n.includes('notosans')) return 'noto';
  if (n.includes('robotocondensed') || (n.includes('condensed') && !n.includes('serif'))) return 'condensed';
  if (n.includes('sourceserif')) return 'sourceserif';
  if (n.includes('playfair')) return 'playfair';
  if (n.includes('caveat')) return 'caveat';
  return family;
}

/**
 * Finds the line of text at (x, y) on page `index` (page points) and reads its
 * look. Returns null when there is no text there.
 */
export function findLine(doc: number, index: number, chars: PChar[], x: number, y: number): FoundLine | null {
  const lines = pageLines(chars);
  const pad = 2;
  let best: PChar[] | null = null;
  let bestD = Infinity;
  for (const l of lines) {
    const t = Math.min(...l.map((c) => c.y0));
    const b = Math.max(...l.map((c) => c.y1));
    const x0 = l[0].x0;
    const x1 = l[l.length - 1].x1;
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = y < t ? t - y : y > b ? y - b : 0;
    const d = Math.hypot(dx, dy);
    if (d <= pad && d < bestD) {
      best = l;
      bestD = d;
    }
  }
  if (!best) return null;
  const line = best;
  const m = pdfium();
  const page = m.EPDF_LoadPageNormalized(doc, index, 0);
  if (!page) return null;
  try {
    const pageW = m.FPDF_GetPageWidthF(page);
    const t = new PageText(page, m.FPDF_GetPageHeightF(page));
    try {
      // Match the chars of this page load by index (same page, same order).
      const byI = new Map(t.chars.map((c) => [c.i, c]));
      const first = byI.get(line[0].i) ?? line[0];
      const info = t.font(first);
      const origin = t.origin(first);
      const angle = t.angle(first);
      const sizes = line.map((c) => c.size).sort((a, b) => a - b);
      const size = Math.round(sizes[Math.floor(sizes.length / 2)] * 10) / 10;
      const top = Math.min(...line.map((c) => c.y0));
      const bottom = Math.max(...line.map((c) => c.y1));
      const baseline = origin ? origin[1] : bottom - size * 0.22;
      const found: FoundLine = {
        chars: line,
        text: lineText(line, chars),
        x0: line[0].x0,
        x1: line[line.length - 1].x1,
        top,
        bottom,
        baseline,
        size,
        color: first.rgb,
        pdfFont: info.name || 'Unnamed font',
        font: closestFont(info.name, info.family),
        bold: info.bold,
        italic: info.italic,
        align: guessAlign(line, lines, pageW),
        fontData: t.fontData(first),
        glyphs: [...new Set(t.chars.filter((c) => t.font(c).name === info.name).map((c) => c.ch))].join(''),
      };
      if (line.some((c) => c.faint)) found.problem = 'This text is invisible (for example the hidden text layer of a scan). Edit the visible picture with other tools.';
      else if (Math.abs(angle) > 0.02 && Math.abs(angle - Math.PI * 2) > 0.02) found.problem = 'This line is slanted or turned. Nib-E can only edit straight lines for now.';
      return found;
    } finally {
      t.close();
    }
  } finally {
    m.FPDF_ClosePage(page);
  }
}

/** The strip through a line that saving clears: the middle of the letters, so lines above and below are never touched. */
export function removalArea(l: Pick<FoundLine, 'x0' | 'x1' | 'baseline' | 'size'>): Rect {
  // From x-height down to just below the baseline (catches commas and full stops),
  // well clear of the descenders above and the capitals below.
  const top = l.baseline - l.size * 0.62;
  const bottom = l.baseline + l.size * 0.12;
  return { x: l.x0 + 0.2, y: top, w: Math.max(0.5, l.x1 - l.x0 - 0.4), h: bottom - top };
}

const bgCache = new Map<string, { r: ReturnType<typeof renderPage>; scale: number }>();

/** The colour behind a line (most common colour just around it), for the on-screen cover. */
export function backgroundAround(doc: number, index: number, cacheKey: string, area: Rect & { pad: number }): string {
  let hit = bgCache.get(cacheKey);
  if (!hit) {
    const scale = 1.5;
    hit = { r: renderPage(doc, index, scale, false), scale };
    bgCache.set(cacheKey, hit);
    if (bgCache.size > 6) bgCache.delete(bgCache.keys().next().value!);
  }
  const { r, scale } = hit;
  const counts = new Map<string, number>();
  const sample = (x: number, y: number) => {
    const px = Math.round(x * scale);
    const py = Math.round(y * scale);
    if (px < 0 || py < 0 || px >= r.w || py >= r.h) return;
    const o = (py * r.w + px) * 4;
    // Quantise a little so anti-aliasing does not split the vote.
    const key = [r.data[o], r.data[o + 1], r.data[o + 2]].map((v) => Math.min(255, Math.round(v / 8) * 8)).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const { x, y, w, h, pad } = area;
  for (let k = 0; k <= 40; k++) {
    const sx = x + (w * k) / 40;
    sample(sx, y - pad);
    sample(sx, y + h + pad);
  }
  for (let k = 0; k <= 10; k++) {
    const sy = y + (h * k) / 10;
    sample(x - pad, sy);
    sample(x + w + pad, sy);
  }
  let best = '255,255,255';
  let n = -1;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return `#${best
    .split(',')
    .map((v) => Number(v).toString(16).padStart(2, '0'))
    .join('')}`;
}

export type { Box };
