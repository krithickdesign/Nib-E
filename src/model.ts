// Core data model. Page entries and items are immutable: every edit replaces
// objects instead of changing them, so undo/redo keeps cheap snapshots.
//
// Coordinates: "page points" are unrotated PDF points with the origin at the
// top-left of the visible page (crop box), y growing downwards. Rotation of a
// page only changes how it is shown, never where its items are stored.
import type { PdfDocumentObject } from '@embedpdf/models';

/** Quarter turns clockwise. */
export type Rot = 0 | 1 | 2 | 3;
/** x, y in page points, pressure 0..1. */
export type Pt = [number, number, number];
/** Font of typed text: a standard PDF font or a font bundled with Nib-E (see fonts.ts). */
export type FontFamily = import('./fonts').FontId;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
}

export interface InkItem extends Base {
  type: 'ink';
  kind: 'pen' | 'highlighter';
  color: string;
  size: number;
  /** No real pressure (mouse, finger): drawn with even width. */
  sim: boolean;
  pts: Pt[];
  /** Pen feel when drawn (missing on strokes from v0.3 = 'smooth'). */
  feel?: 'precise' | 'balanced' | 'smooth';
}

export interface TextItem extends Base, Rect {
  type: 'text';
  /** Quarter turns clockwise of the text inside its box (keeps text upright on turned pages). */
  rot: Rot;
  text: string;
  font: FontFamily;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  valign: 'top' | 'middle';
  /** Wrap long lines at the box width (otherwise the box grows). */
  wrap: boolean;
  /** Detected form box this answer belongs to. */
  field?: string;
  /** Paint white behind the text (hides placeholder text on a line). */
  cover?: boolean;
  /** Lines inside the box: left (default), centred or right-aligned. */
  align?: 'left' | 'center' | 'right';
  /** This box replaces a line of the PDF's own text (Content editor → Edit text). */
  replace?: ReplaceInfo;
}

/**
 * A line of the PDF's own text being replaced. On save the original characters
 * in `area` are removed from the page (like redaction, but text only: pictures
 * and drawings stay), then the new text is written, in the original font when
 * it has every character, else in the closest font Nib-E has.
 */
export interface ReplaceInfo {
  /** Where the original text is removed (page points; a strip through the line). */
  area: Rect;
  /** The original line's box: covered on screen with `bg` until saving removes the text. */
  hide: Rect;
  /** The original text. */
  orig: string;
  /** Characters the PDF's font is known to have (drawn elsewhere on the page with it). */
  glyphs: string;
  /** Font name in the PDF, without the subset prefix (e.g. "Calibri-Bold"). */
  pdfFont: string;
  /** Size, bold and italic as found; the original font is only reused while these are unchanged. */
  font0: { font: FontFamily; size: number; bold: boolean; italic: boolean };
  /** A point on the first character, to find the original font again when saving. */
  probe: [number, number];
  /** Colour behind the line (covers the old text on screen; saving removes it for real). */
  bg: string;
  /** Screen-only font made from the PDF's embedded font, if the browser could load it. */
  css?: string;
}

export interface MarkItem extends Base, Rect {
  type: 'mark';
  shape: 'check' | 'cross' | 'dot';
  color: string;
  field?: string;
}

export interface ShapeItem extends Base {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface NoteItem extends Base {
  type: 'note';
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface StampItem extends Base, Rect {
  type: 'stamp';
  rot: Rot;
  label: string;
  sub: string;
  color: string;
}

export interface ImageItem extends Base, Rect {
  type: 'image';
  rot: Rot;
  image: string;
}

export interface MarkupItem extends Base {
  type: 'markup';
  kind: 'highlight' | 'underline' | 'strike';
  color: string;
  rects: Rect[];
}

export interface LinkItem extends Base, Rect {
  type: 'link';
  url: string;
}

export interface RedactItem extends Base, Rect {
  type: 'redact';
}

/** A form field added by hand in the Form builder. */
export interface FieldItem extends Base, Rect {
  type: 'field';
  kind: 'text' | 'check';
  name: string;
}

export type Item = InkItem | TextItem | MarkItem | ShapeItem | NoteItem | StampItem | ImageItem | MarkupItem | LinkItem | RedactItem | FieldItem;
export type ItemType = Item['type'];

export type Template = 'blank' | 'lined' | 'grid';

export interface Source {
  id: string;
  name: string;
  doc: PdfDocumentObject;
  bytes: Uint8Array;
}

export interface PageEntry {
  key: string;
  /** null = page inserted by Nib-E. */
  src: string | null;
  index: number;
  w: number;
  h: number;
  baseRot: Rot;
  rot: Rot;
  template: Template;
  items: Item[];
}

export interface HeaderFooter {
  header: [string, string, string];
  footer: [string, string, string];
  size: number;
  color: string;
  margin: number;
}

export interface Watermark {
  text: string;
  size: number;
  color: string;
  opacity: number;
  diagonal: boolean;
}

/** Everything that undo/redo restores. */
export interface Plan {
  pages: PageEntry[];
  notes: PageEntry[];
  hf: HeaderFooter | null;
  wm: Watermark | null;
}

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function totalRot(p: PageEntry): Rot {
  return ((p.baseRot + p.rot) % 4) as Rot;
}

/** Size of the page as shown on screen (after rotation), in points. */
export function shownSize(p: PageEntry): { w: number; h: number } {
  return totalRot(p) % 2 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** Screen point (points, shown orientation) -> page point. */
export function toPage(p: PageEntry, dx: number, dy: number): [number, number] {
  const { w: W, h: H } = p;
  switch (totalRot(p)) {
    case 1:
      return [dy, H - dx];
    case 2:
      return [W - dx, H - dy];
    case 3:
      return [W - dy, dx];
    default:
      return [dx, dy];
  }
}

/** Page point -> screen point (points, shown orientation). */
export function toScreen(p: PageEntry, ux: number, uy: number): [number, number] {
  const { w: W, h: H } = p;
  switch (totalRot(p)) {
    case 1:
      return [H - uy, ux];
    case 2:
      return [W - ux, H - uy];
    case 3:
      return [uy, W - ux];
    default:
      return [ux, uy];
  }
}

/** Page rect -> screen rect (points, shown orientation). */
export function rectToScreen(p: PageEntry, r: Rect): Rect {
  const [ax, ay] = toScreen(p, r.x, r.y);
  const [bx, by] = toScreen(p, r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Screen rect -> page rect. */
export function rectToPage(p: PageEntry, r: Rect): Rect {
  const [ax, ay] = toPage(p, r.x, r.y);
  const [bx, by] = toPage(p, r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Canvas transform that maps page points to screen pixels. */
export function pageMatrix(p: PageEntry, scale: number): [number, number, number, number, number, number] {
  const { w: W, h: H } = p;
  const s = scale;
  switch (totalRot(p)) {
    case 1:
      return [0, s, -s, 0, H * s, 0];
    case 2:
      return [-s, 0, 0, -s, W * s, H * s];
    case 3:
      return [0, -s, s, 0, 0, W * s];
    default:
      return [s, 0, 0, s, 0, 0];
  }
}

/** Rotation that makes new content upright on screen for this page. */
export function uprightRot(p: PageEntry): Rot {
  return ((4 - totalRot(p)) % 4) as Rot;
}

/** Size of an item's content before its own rotation. */
export function contentSize(r: { w: number; h: number; rot: Rot }): { w: number; h: number } {
  return r.rot % 2 ? { w: r.h, h: r.w } : { w: r.w, h: r.h };
}

/**
 * Maps a point in an item's upright content box (u right, v down) to page
 * points. Used by both the screen renderer and the PDF writer.
 */
export function contentToPage(r: Rect & { rot: Rot }, u: number, v: number): [number, number] {
  const { w: cw, h: ch } = contentSize(r);
  const dx = u - cw / 2;
  const dy = v - ch / 2;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  switch (r.rot) {
    case 1:
      return [cx - dy, cy + dx];
    case 2:
      return [cx - dx, cy - dy];
    case 3:
      return [cx + dy, cy - dx];
    default:
      return [cx + dx, cy + dy];
  }
}

/** Ruling for pages inserted by Nib-E, as line segments in page points. */
export function templateLines(t: Template, w: number, h: number): [number, number, number, number][] {
  const lines: [number, number, number, number][] = [];
  if (t === 'lined') {
    const gap = 22.68; // 8 mm
    for (let y = 72; y <= h - 40; y += gap) lines.push([36, y, w - 36, y]);
  } else if (t === 'grid') {
    const gap = 14.17; // 5 mm
    const x0 = (w % gap) / 2;
    const y0 = (h % gap) / 2;
    for (let x = x0; x <= w; x += gap) lines.push([x, 0, x, h]);
    for (let y = y0; y <= h; y += gap) lines.push([0, y, w, y]);
  }
  return lines;
}

export const TEMPLATE_RGB: [number, number, number] = [200, 206, 222];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Bounding box of any item in page points. */
export function itemBounds(it: Item): Rect {
  switch (it.type) {
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of it.pts) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      const p = it.size / 2;
      return { x: x0 - p, y: y0 - p, w: x1 - x0 + 2 * p, h: y1 - y0 + 2 * p };
    }
    case 'shape': {
      const p = it.width / 2 + (it.shape === 'arrow' ? it.width * 3 : 0);
      return { x: Math.min(it.x1, it.x2) - p, y: Math.min(it.y1, it.y2) - p, w: Math.abs(it.x2 - it.x1) + 2 * p, h: Math.abs(it.y2 - it.y1) + 2 * p };
    }
    case 'note':
      return { x: it.x, y: it.y, w: NOTE_SIZE, h: NOTE_SIZE };
    case 'markup': {
      const xs = it.rects.flatMap((r) => [r.x, r.x + r.w]);
      const ys = it.rects.flatMap((r) => [r.y, r.y + r.h]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    default:
      return { x: it.x, y: it.y, w: it.w, h: it.h };
  }
}

export const NOTE_SIZE = 18;

/** Moves an item by dx, dy page points. */
export function moveItem<T extends Item>(it: T, dx: number, dy: number): T {
  switch (it.type) {
    case 'ink':
      return { ...it, pts: it.pts.map(([x, y, p]) => [x + dx, y + dy, p] as Pt) };
    case 'shape':
      return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
    case 'markup':
      return { ...it, rects: it.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    case 'note':
      return { ...it, x: it.x + dx, y: it.y + dy };
    default:
      return { ...it, x: (it as Rect).x + dx, y: (it as Rect).y + dy } as T;
  }
}

/** Items that can be resized with handles (box-shaped). */
export function isBoxItem(it: Item): it is TextItem | StampItem | ImageItem | LinkItem | RedactItem | FieldItem | MarkItem {
  return it.type === 'text' || it.type === 'stamp' || it.type === 'image' || it.type === 'link' || it.type === 'redact' || it.type === 'field' || it.type === 'mark';
}

export const DEFAULT_HF: HeaderFooter = {
  header: ['', '', ''],
  footer: ['', 'Page {page} of {pages}', ''],
  size: 9,
  color: '#4a4f63',
  margin: 24,
};

export const DEFAULT_WM: Watermark = {
  text: 'CONFIDENTIAL',
  size: 64,
  color: '#c42a35',
  opacity: 0.18,
  diagonal: true,
};

export function fillTokens(s: string, page: number, pages: number, file: string): string {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return s.replaceAll('{page}', String(page)).replaceAll('{pages}', String(pages)).replaceAll('{date}', date).replaceAll('{file}', file);
}
