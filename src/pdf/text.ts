// Reads characters and their positions from a PDF page. Used to find form
// labels, to snap highlights to text, and for find-and-redact.
import { free, heap, malloc, pageBox, pdfium, readFloats, type Box, type FontFamily } from './core';

/** One character, in Nib-E page points (origin top-left of the visible page). */
export interface PChar {
  i: number;
  ch: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  /** Invisible (render mode 3, transparent) or near-white ink. Still real text for search and redaction. */
  faint: boolean;
  /** The text object that draws this character (used to work out drawing order). */
  obj: number;
  /** Luminance of the text colour (0 black … 1 white). */
  lum: number;
  /** Text colour as #rrggbb. */
  rgb: string;
}

export interface FontInfo {
  name: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FLAG_FIXED = 1;
const FLAG_SERIF = 2;
const FLAG_ITALIC = 64;

export function familyOf(name: string, flags: number): FontFamily {
  const n = name.toLowerCase();
  if (flags & FLAG_FIXED || /courier|mono|consol|menlo|typewriter/.test(n)) return 'mono';
  if (/sans|arial|helvet|calibri|verdana|segoe|roboto|tahoma|frutiger|univers|futura|gill|myriad|open|lato|noto ?sans/.test(n)) return 'sans';
  if (/times|serif|georgia|garamond|cambria|minion|palatino|bookman|century|roman|baskerville/.test(n)) return 'serif';
  return flags & FLAG_SERIF ? 'serif' : 'sans';
}

/** Opens a page's text layer. Call close() when done. */
export class PageText {
  readonly chars: PChar[] = [];
  readonly box: Box;
  private tp: number;
  private fonts = new Map<number, FontInfo>();

  constructor(page: number, pageHeight: number) {
    const m = pdfium();
    this.box = pageBox(page, pageHeight);
    this.tp = m.FPDFText_LoadPage(page);
    if (!this.tp) return;
    const n = m.FPDFText_CountChars(this.tp);
    const r = malloc(16);
    const col = malloc(16);
    try {
      for (let i = 0; i < n; i++) {
        const code = m.FPDFText_GetUnicode(this.tp, i);
        if (!code) continue;
        if (!m.FPDFText_GetLooseCharBox(this.tp, i, r)) continue;
        const [left, top, right, bottom] = readFloats(r, 4);
        if (!(right > left) && code !== 32) continue;
        let faint = false;
        let lum = 0;
        let rgb = '#000000';
        const obj = m.FPDFText_GetTextObject(this.tp, i);
        if (code > 32) {
          if (m.FPDFText_GetFillColor(this.tp, i, col, col + 4, col + 8, col + 12)) {
            const [cr, cg, cb, ca] = Array.from(new Uint32Array(heap().buffer, col, 4));
            lum = (0.2126 * cr + 0.7152 * cg + 0.0722 * cb) / 255;
            rgb = `#${[cr, cg, cb].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
            faint = ca < 20 || lum > 0.95;
          }
          if (obj && m.FPDFTextObj_GetTextRenderMode(obj) === 3) faint = true;
        }
        this.chars.push({
          faint,
          obj,
          lum,
          rgb,
          i,
          ch: String.fromCodePoint(code),
          x0: left - this.box.left,
          x1: right - this.box.left,
          y0: this.box.top - top,
          y1: this.box.top - bottom,
          size: m.FPDFText_GetFontSize(this.tp, i),
        });
      }
    } finally {
      free(r);
      free(col);
    }
  }

  font(c: PChar): FontInfo {
    let f = this.fonts.get(c.i);
    if (f) return f;
    const m = pdfium();
    const buf = malloc(256);
    const flags = malloc(4);
    try {
      const len = m.FPDFText_GetFontInfo(this.tp, c.i, buf, 256, flags);
      let name = '';
      if (len > 1) name = new TextDecoder().decode(heap().slice(buf, buf + Math.min(len, 256) - 1));
      name = name.replace(/^[A-Z]{6}\+/, '');
      const fl = new Int32Array(heap().buffer, flags, 1)[0];
      const weight = m.FPDFText_GetFontWeight(this.tp, c.i);
      f = {
        name,
        family: familyOf(name, fl),
        bold: weight >= 600 || /bold|black|heavy|semibold/i.test(name),
        italic: !!(fl & FLAG_ITALIC) || /italic|oblique/i.test(name),
      };
    } finally {
      free(buf);
      free(flags);
    }
    this.fonts.set(c.i, f);
    return f;
  }

  /** Baseline origin of a character, in page points. */
  origin(c: PChar): [number, number] | null {
    const m = pdfium();
    const p = malloc(16);
    try {
      if (!m.FPDFText_GetCharOrigin(this.tp, c.i, p, p + 8)) return null;
      const [x, y] = new Float64Array(heap().buffer.slice(p, p + 16));
      return [x - this.box.left, this.box.top - y];
    } finally {
      free(p);
    }
  }

  /** Angle of a character's baseline (radians, 0 = horizontal). */
  angle(c: PChar): number {
    const a = pdfium().FPDFText_GetCharAngle(this.tp, c.i);
    return a < 0 ? 0 : a;
  }

  /** The font file embedded for a character, when the PDF has one. */
  fontData(c: PChar): Uint8Array | null {
    const m = pdfium();
    const obj = m.FPDFText_GetTextObject(this.tp, c.i);
    const font = obj ? m.FPDFTextObj_GetFont(obj) : 0;
    if (!font || !m.FPDFFont_GetIsEmbedded(font)) return null;
    const lenPtr = malloc(8);
    try {
      if (!m.FPDFFont_GetFontData(font, 0, 0, lenPtr)) return null;
      const len = new Uint32Array(heap().buffer, lenPtr, 1)[0];
      if (!len || len > 30_000_000) return null;
      const buf = malloc(len);
      try {
        if (!m.FPDFFont_GetFontData(font, buf, len, lenPtr)) return null;
        return heap().slice(buf, buf + len);
      } finally {
        free(buf);
      }
    } finally {
      free(lenPtr);
    }
  }

  close(): void {
    if (this.tp) pdfium().FPDFText_ClosePage(this.tp);
    this.tp = 0;
  }
}

/** Opens page `index` of a raw document, reads its text, and closes it again. */
export function readPageChars(doc: number, index: number): PChar[] {
  const m = pdfium();
  const page = m.EPDF_LoadPageNormalized(doc, index, 0);
  if (!page) return [];
  try {
    const t = new PageText(page, m.FPDF_GetPageHeightF(page));
    const chars = t.chars;
    t.close();
    return chars;
  } finally {
    m.FPDF_ClosePage(page);
  }
}

const isSpace = (c: PChar) => /\s/.test(c.ch);

/** Groups characters (in reading order) into line rectangles. */
export function lineRects(chars: PChar[]): Rect[] {
  const rects: Rect[] = [];
  let cur: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const c of chars) {
    if (isSpace(c) && !(c.x1 > c.x0)) continue;
    if (cur) {
      const cy = (c.y0 + c.y1) / 2;
      const h = cur.y1 - cur.y0;
      const sameLine = cy > cur.y0 - h * 0.1 && cy < cur.y1 + h * 0.1 && c.x0 > cur.x0 - 2 && c.x0 - cur.x1 < h * 3;
      if (sameLine) {
        cur.x0 = Math.min(cur.x0, c.x0);
        cur.x1 = Math.max(cur.x1, c.x1);
        cur.y0 = Math.min(cur.y0, c.y0);
        cur.y1 = Math.max(cur.y1, c.y1);
        continue;
      }
      rects.push({ x: cur.x0, y: cur.y0, w: cur.x1 - cur.x0, h: cur.y1 - cur.y0 });
    }
    cur = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
  }
  if (cur) rects.push({ x: cur.x0, y: cur.y0, w: cur.x1 - cur.x0, h: cur.y1 - cur.y0 });
  return rects.filter((r) => r.w > 0.5 && r.h > 0.5);
}

/** Characters whose centre lies inside a rectangle. */
export function charsIn(chars: PChar[], r: Rect, pad = 0): PChar[] {
  return chars.filter((c) => {
    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.y0 + c.y1) / 2;
    return cx >= r.x - pad && cx <= r.x + r.w + pad && cy >= r.y - pad && cy <= r.y + r.h + pad;
  });
}

/** Characters touched by a rectangle (any overlap). */
export function charsTouching(chars: PChar[], r: Rect): PChar[] {
  return chars.filter((c) => !isSpace(c) && c.x1 > r.x && c.x0 < r.x + r.w && c.y1 > r.y && c.y0 < r.y + r.h);
}

/** Finds every occurrence of `query` (case-insensitive). Each match is a list of line rects. */
export function findText(chars: PChar[], query: string): Rect[][] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  let text = '';
  const map: number[] = [];
  for (let k = 0; k < chars.length; k++) {
    const ch = /\s/.test(chars[k].ch) ? ' ' : chars[k].ch.toLowerCase();
    if (ch === ' ' && text.endsWith(' ')) continue;
    text += ch;
    map.push(k);
  }
  const out: Rect[][] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(q, from);
    if (at < 0) break;
    const hit = map.slice(at, at + q.length).map((k) => chars[k]);
    out.push(lineRects(hit));
    from = at + q.length;
  }
  return out;
}
