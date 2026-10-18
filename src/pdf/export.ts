// Builds the output PDF from the page plan.
//
// Strategy: start from the first opened file (so its form fields, outline and
// metadata survive), append pages from other files and new blank pages,
// delete the pages the plan dropped, then move everything into plan order.
// Rotation, ruling, header/footer, watermark and items are applied last.
// The documents shown on screen are never modified.
import { ensureFormDefaults } from './formactions';
import { decimate, HIGHLIGHT_ALPHA, outline } from '../ink/stroke';
import {
  contentSize,
  contentToPage,
  fillTokens,
  hexToRgb,
  NOTE_SIZE,
  shownSize,
  templateLines,
  TEMPLATE_RGB,
  toPage,
  totalRot,
  type HeaderFooter,
  type ImageItem,
  type InkItem,
  type Item,
  type MarkItem,
  type MarkupItem,
  type NoteItem,
  type PageEntry,
  type Rect,
  type Rot,
  type ShapeItem,
  type Source,
  type StampItem,
  type TextItem,
  type Watermark,
} from '../model';
import { arrowHead, CHECK_PATH, hfSlots, images, keepsPdfFont, layoutText, measure, stampLayout } from '../ui/draw';
import { engineBytes } from './pdfium';
import {
  free,
  heap,
  isWinAnsi,
  malloc,
  openRaw,
  pageBox,
  pdfium,
  readFloats,
  saveRaw,
  standardFontName,
  unsupportedChars,
  withBytes,
  withFloats,
  withInts,
  withWide,
  type Box,
  type FontFamily,
  type Mat,
  type RawDoc,
} from './core';
import type { DetectedField } from './detect';
import { addFillableFields, type OutField } from './fillable';
import { NIB_TAG } from './nibdata';
import { fontBytes, hasItalic, isBundled, type BundledFont } from '../fonts';
import type { FontFamily as TextFont } from '../model';

const FPDF_FONT_TRUETYPE = 2;

/**
 * Bundled fonts embedded into one output document, loaded once each. The
 * font files are fetched before writing (async), so pages can be written
 * synchronously. Embedded as CID fonts, so any character the font has is kept.
 */
export class FontBank {
  private loaded = new Map<string, number>();
  private bytes = new Map<string, Uint8Array>();
  private m = pdfium();

  constructor(private doc: number) {}

  static key(id: string, bold: boolean, italic: boolean): string {
    return `${id}:${bold ? 1 : 0}:${italic && hasItalic(id) ? 1 : 0}`;
  }

  /** Fetches the files for every bundled font style the items use. */
  async prepare(styles: { font: string; bold: boolean; italic: boolean }[]): Promise<void> {
    for (const s of styles) {
      if (!isBundled(s.font)) continue;
      const k = FontBank.key(s.font, s.bold, s.italic);
      if (!this.bytes.has(k)) this.bytes.set(k, await fontBytes(s.font as BundledFont, s.bold, s.italic && hasItalic(s.font)));
    }
  }

  /** PDFium font handle for a bundled font style (0 if it could not be loaded). */
  get(id: string, bold: boolean, italic: boolean): number {
    const k = FontBank.key(id, bold, italic);
    let f = this.loaded.get(k);
    if (f !== undefined) return f;
    const data = this.bytes.get(k);
    f = data ? withBytes(data, (ptr, len) => this.m.FPDFText_LoadFont(this.doc, ptr, len, FPDF_FONT_TRUETYPE, true)) : 0;
    this.loaded.set(k, f);
    return f;
  }

  close(): void {
    for (const f of this.loaded.values()) if (f) this.m.FPDFFont_Close(f);
    this.loaded.clear();
  }
}

/** Every text style used by these pages (to prepare their fonts). */
export function textStyles(pages: PageEntry[]): { font: string; bold: boolean; italic: boolean }[] {
  const out: { font: string; bold: boolean; italic: boolean }[] = [];
  for (const p of pages)
    for (const it of p.items) {
      if (it.type !== 'text') continue;
      out.push({ font: it.font, bold: it.bold, italic: it.italic });
      // A replaced line whose characters a standard font can't store uses an included font instead.
      if (it.replace) out.push({ font: replaceFallback(it), bold: it.bold, italic: it.italic });
    }
  return out;
}

/** Font for a replaced line when the PDF's own font can't be reused. */
export function replaceFallback(t: TextItem): TextFont {
  if (isBundled(t.font) || !unsupportedChars(t.text).length) return t.font;
  return t.font === 'serif' ? 'sourceserif' : 'noto';
}

const ANNOT_TEXT = 1;
const ANNOT_LINK = 2;
const ANNOT_SQUARE = 5;
const ANNOT_CIRCLE = 6;
const ANNOT_HIGHLIGHT = 9;
const ANNOT_UNDERLINE = 10;
const ANNOT_STRIKEOUT = 12;
const ANNOT_INK = 15;
const FLAG_PRINT = 4;
const FLAG_NOZOOM = 8;
const FLAG_NOROTATE = 16;
const COLORTYPE_COLOR = 0;
const APPEARANCE_NORMAL = 0;

export interface ExportInput {
  primary: string;
  sources: Map<string, Source>;
  pages: PageEntry[];
  /** Header/footer and watermark apply to the first `docPages` pages (notes come after). */
  docPages: number;
  hf: HeaderFooter | null;
  wm: Watermark | null;
  fileName: string;
  /** Turn detected boxes and hand-made fields into real form fields. */
  fillable: boolean;
  fieldsFor: (p: PageEntry) => DetectedField[];
}

export async function buildPdf(input: ExportInput): Promise<Uint8Array> {
  const { primary, sources, pages } = input;
  if (!pages.length) throw new Error('There are no pages to save.');
  const m = pdfium();
  const first = sources.get(primary);
  if (!first) throw new Error('The original file is no longer open.');

  const open: RawDoc[] = [];
  const bytesCache = new Map<string, Uint8Array>();
  const bytesOf = async (id: string) => {
    let b = bytesCache.get(id);
    if (!b) {
      const src = sources.get(id);
      if (!src) throw new Error('A merged file is no longer open.');
      b = await engineBytes(src.doc);
      bytesCache.set(id, b);
    }
    return b;
  };
  const rawCache = new Map<string, RawDoc>();
  const rawOf = async (id: string) => {
    let r = rawCache.get(id);
    if (!r) {
      r = openRaw(await bytesOf(id));
      open.push(r);
      rawCache.set(id, r);
    }
    return r;
  };

  const out: OutField[] = [];
  let bytes: Uint8Array;
  let bank: FontBank | null = null;
  try {
    const target = openRaw(await bytesOf(primary));
    open.push(target);
    const D = target.doc;
    bank = new FontBank(D);
    await bank.prepare(textStyles(pages));
    const n0 = m.FPDF_GetPageCount(D);
    const claimed = new Set<number>();
    const at: number[] = [];
    let count = n0;

    for (let i = 0; i < pages.length; i++) {
      const e = pages[i];
      if (e.src === primary && !claimed.has(e.index)) {
        claimed.add(e.index);
        at[i] = e.index;
        continue;
      }
      if (e.src === null) {
        const pg = m.FPDFPage_New(D, count, e.w, e.h);
        if (!pg) throw new Error('Could not add a blank page.');
        m.FPDF_ClosePage(pg);
      } else {
        // A page from another file, or a second copy of a page from the first file.
        // rawOf() opens its own copy, separate from the target, so both cases work.
        const from = await rawOf(e.src);
        const ok = withInts([e.index], (ptr) => m.FPDF_ImportPagesByIndex(D, from.doc, ptr, 1, count));
        if (!ok) throw new Error(`Could not copy page ${e.index + 1}.`);
      }
      at[i] = count;
      count += 1;
    }

    for (let j = n0 - 1; j >= 0; j--) {
      if (claimed.has(j)) continue;
      m.FPDFPage_Delete(D, j);
      for (let k = 0; k < at.length; k++) if (at[k] > j) at[k] -= 1;
    }

    if (at.some((v, i) => v !== i)) {
      const ok = withInts(at, (ptr) => m.FPDF_MovePages(D, ptr, at.length, 0));
      if (!ok) throw new Error('Could not reorder pages.');
    }

    for (let i = 0; i < pages.length; i++) {
      const e = pages[i];
      const page = m.FPDF_LoadPage(D, i);
      if (!page) throw new Error(`Could not open page ${i + 1} for writing.`);
      try {
        m.FPDFPage_SetRotation(page, totalRot(e));
        const box = pageBox(page, e.h);
        const w = new Writer(D, page, box, e, bank);
        // Edited lines of the PDF's own text: the old characters go first, before anything is added.
        w.beginReplacements(e.items);
        if (e.src === null && e.template !== 'blank') w.ruling();
        if (i < input.docPages) {
          if (input.wm) w.watermark(input.wm);
          if (input.hf) w.headerFooter(input.hf, i + 1, input.docPages, input.fileName);
        }
        const fields = input.fillable ? input.fieldsFor(e) : [];
        const linked = new Set(fields.map((f) => f.id));
        for (const it of e.items) {
          if (input.fillable && (it.type === 'text' || it.type === 'mark') && it.field && linked.has(it.field)) continue;
          w.item(it);
        }
        w.finish();
        if (input.fillable) collectFields(out, i, e, box, fields);
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
    bytes = saveRaw(D);
  } finally {
    bank?.close();
    for (const r of open.reverse()) r.close();
  }
  if (input.fillable && out.length) bytes = await addFillableFields(bytes, out);
  // Forms without a default font: add one, so other apps can draw the answers.
  bytes = await ensureFormDefaults(bytes);
  return bytes;
}

function collectFields(out: OutField[], pageIndex: number, e: PageEntry, box: Box, fields: DetectedField[]): void {
  const toUser = (r: Rect) => ({ x: box.left + r.x, y: box.top - r.y - r.h, w: r.w, h: r.h });
  for (const f of fields) {
    const text = e.items.filter((it): it is TextItem => it.type === 'text' && it.field === f.id).map((t) => t.text).join(' ');
    const mark = e.items.some((it) => it.type === 'mark' && it.field === f.id);
    out.push({
      page: pageIndex,
      kind: f.kind,
      rect: toUser(f),
      name: f.label || (f.kind === 'text' ? 'Field' : 'Choice'),
      value: text,
      checked: mark,
      group: f.group ? `${pageIndex}:${f.group}` : undefined,
      option: f.option,
      font: f.font,
      size: f.size,
      multiline: f.multiline,
    });
  }
  for (const it of e.items) {
    if (it.type !== 'field') continue;
    out.push({ page: pageIndex, kind: it.kind, rect: toUser(it), name: it.name || 'Field', value: '', checked: false, font: 'sans', size: 11, multiline: it.h > 30 });
  }
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Writes Nib-E content onto one output page. */
class Writer {
  private m = pdfium();
  private dirty = false;

  constructor(private doc: number, private page: number, private box: Box, private e: PageEntry, private fonts: FontBank) {}

  /** Page point -> PDF user space. */
  u(x: number, y: number): [number, number] {
    return [this.box.left + x, this.box.top - y];
  }

  finish(): void {
    if (this.dirty) this.m.FPDFPage_GenerateContent(this.page);
  }

  /** Text objects in the PDF's own font for replaced lines, made before the old text is removed (they keep the font alive). */
  private prepared = new Map<string, number>();

  /**
   * Removes the original characters of every replaced line on this page (text
   * only: pictures and drawings under them stay). Lines whose look is unchanged
   * first get a text object in the PDF's own font.
   */
  beginReplacements(items: Item[]): void {
    const list = items.filter((it): it is TextItem => it.type === 'text' && !!it.replace);
    if (!list.length) return;
    const m = this.m;
    const tp = m.FPDFText_LoadPage(this.page);
    try {
      for (const t of list) {
        if (!keepsPdfFont(t) || !t.text.trim() || !tp) continue;
        // PDFs usually carry only the characters they use: reuse the font only
        // when every new character is already drawn with it on this page.
        const known = t.replace!.glyphs;
        if (![...t.text].every((ch) => /\s/.test(ch) || known.includes(ch))) continue;
        const [ux, uy] = this.u(t.replace!.probe[0], t.replace!.probe[1]);
        const idx = m.FPDFText_GetCharIndexAtPos(tp, ux, uy, 3, 3);
        if (idx < 0) continue;
        const src = m.FPDFText_GetTextObject(tp, idx);
        const font = src ? m.FPDFTextObj_GetFont(src) : 0;
        if (!font) continue;
        const obj = m.FPDFPageObj_CreateTextObj(this.doc, font, t.size);
        if (!obj) continue;
        if (!withWide(t.text, (ptr) => m.FPDFText_SetText(obj, ptr))) {
          m.FPDFPageObj_Destroy(obj);
          continue;
        }
        this.prepared.set(t.id, obj);
      }
    } finally {
      if (tp) m.FPDFText_ClosePage(tp);
    }
    const quads: number[] = [];
    for (const t of list) {
      const a = t.replace!.area;
      const [x0, yTop] = this.u(a.x, a.y);
      const [x1, yBot] = this.u(a.x + a.w, a.y + a.h);
      // Quad order: upper-left, upper-right, lower-left, lower-right.
      quads.push(x0, yTop, x1, yTop, x0, yBot, x1, yBot);
    }
    withFloats(quads, (ptr) => m.EPDFText_RedactInQuads(this.page, ptr, list.length, true, false));
    this.dirty = true;
  }

  /** Characters a text object on this page reads back as (to check a font has every character). */
  private readBack(obj: number): string {
    const m = this.m;
    const tp = m.FPDFText_LoadPage(this.page);
    if (!tp) return '';
    try {
      let s = '';
      const n = m.FPDFText_CountChars(tp);
      for (let i = 0; i < n; i++) if (m.FPDFText_GetTextObject(tp, i) === obj) s += String.fromCodePoint(m.FPDFText_GetUnicode(tp, i) || 0xfffd);
      return s;
    } finally {
      m.FPDFText_ClosePage(tp);
    }
  }

  /** Puts a text object on the line of a text box, aligned like the box (left, centre, right). */
  private placeOnLine(obj: number, t: TextItem): void {
    const m = this.m;
    const lay = layoutText(t);
    const b = malloc(16);
    let width = 0;
    try {
      if (m.FPDFPageObj_GetBounds(obj, b, b + 4, b + 8, b + 12)) width = readFloats(b, 4)[2];
    } finally {
      free(b);
    }
    let x = t.x + lay.padX;
    if (t.align === 'right') x = t.x + t.w - lay.padX - width;
    else if (t.align === 'center') x = t.x + t.w / 2 - width / 2;
    const [ux, uy] = this.u(x, t.y + lay.base);
    m.FPDFPageObj_Transform(obj, 1, 0, 0, 1, ux, uy);
  }

  /** A replaced line: the new text, in the PDF's own font when it has every character, else the closest font. */
  private replaceText(t: TextItem): void {
    const m = this.m;
    let obj = this.prepared.get(t.id) ?? 0;
    this.prepared.delete(t.id);
    if (!t.text.trim()) {
      if (obj) m.FPDFPageObj_Destroy(obj);
      return;
    }
    const strip = (s: string) => s.replace(/\s+/g, '');
    if (obj) {
      this.placeOnLine(obj, t);
      m.FPDFPageObj_SetFillColor(obj, ...hexToRgb(t.color), 255);
      this.insert(obj);
      if (strip(this.readBack(obj)) !== strip(t.text)) {
        // The PDF's font lacks some characters (fonts are often cut down to the ones used).
        m.FPDFPage_RemoveObject(this.page, obj);
        m.FPDFPageObj_Destroy(obj);
        obj = 0;
      }
    }
    if (obj) return;
    const font = replaceFallback(t);
    const embedded = isBundled(font) ? this.fonts.get(font, t.bold, t.italic) : 0;
    const std = (isBundled(font) ? 'sans' : font) as FontFamily;
    const safe = embedded ? t.text : [...t.text].map((c) => (isWinAnsi(c) ? c : '?')).join('');
    const o = embedded ? m.FPDFPageObj_CreateTextObj(this.doc, embedded, t.size) : m.FPDFPageObj_NewTextObj(this.doc, standardFontName(std, t.bold, t.italic), t.size);
    if (!o) return;
    withWide(safe, (ptr) => m.FPDFText_SetText(o, ptr));
    this.placeOnLine(o, t);
    m.FPDFPageObj_SetFillColor(o, ...hexToRgb(t.color), 255);
    this.insert(o);
  }

  private insert(obj: number): void {
    // Tagged so Nib-E can find its own content again (see nibdata.ts).
    this.m.FPDFPageObj_AddMark(obj, NIB_TAG);
    this.m.FPDFPage_InsertObject(this.page, obj);
    this.dirty = true;
  }

  // ---------- page content helpers ----------

  /** A path through page points. `closed` closes each subpath. */
  private path(subpaths: [number, number][][], opts: { stroke?: string; width?: number; fill?: string; alpha?: number; closed?: boolean; round?: boolean }): void {
    const m = this.m;
    const first = subpaths.find((s) => s.length);
    if (!first) return;
    const [x0, y0] = this.u(first[0][0], first[0][1]);
    const p = m.FPDFPageObj_CreateNewPath(x0, y0);
    let started = false;
    for (const sp of subpaths) {
      if (!sp.length) continue;
      sp.forEach(([x, y], k) => {
        const [ux, uy] = this.u(x, y);
        if (k === 0) {
          if (started) m.FPDFPath_MoveTo(p, ux, uy);
        } else m.FPDFPath_LineTo(p, ux, uy);
      });
      if (opts.closed) m.FPDFPath_Close(p);
      started = true;
    }
    const a = Math.round((opts.alpha ?? 1) * 255);
    if (opts.fill) m.FPDFPageObj_SetFillColor(p, ...hexToRgb(opts.fill), a);
    if (opts.stroke) {
      m.FPDFPageObj_SetStrokeColor(p, ...hexToRgb(opts.stroke), a);
      m.FPDFPageObj_SetStrokeWidth(p, opts.width ?? 1);
      if (opts.round) {
        m.FPDFPageObj_SetLineCap(p, 1);
        m.FPDFPageObj_SetLineJoin(p, 1);
      }
    }
    m.FPDFPath_SetDrawMode(p, opts.fill ? 1 : 0, !!opts.stroke);
    this.insert(p);
  }

  /**
   * One line of text. `frame` maps a text-space origin and direction:
   * origin = baseline start, dir = unit vector along the line, up = unit
   * vector towards the top of the glyphs (all in page points).
   */
  private textRun(str: string, font: TextFont, bold: boolean, italic: boolean, size: number, color: string, alpha: number, origin: [number, number], dir: [number, number], up: [number, number]): void {
    const m = this.m;
    // Bundled fonts are embedded and keep every character they have; the
    // standard PDF fonts only store Western European characters.
    const embedded = isBundled(font) ? this.fonts.get(font, bold, italic) : 0;
    const safe = embedded ? str : [...str].map((c) => (isWinAnsi(c) ? c : '?')).join('');
    if (!safe.trim()) return;
    const std = (isBundled(font) ? 'sans' : font) as FontFamily;
    const t = embedded ? m.FPDFPageObj_CreateTextObj(this.doc, embedded, size) : m.FPDFPageObj_NewTextObj(this.doc, standardFontName(std, bold, italic), size);
    if (!t) return;
    withWide(safe, (ptr) => m.FPDFText_SetText(t, ptr));
    m.FPDFPageObj_SetFillColor(t, ...hexToRgb(color), Math.round(alpha * 255));
    // Page space has y down, PDF user space has y up.
    const [ox, oy] = this.u(origin[0], origin[1]);
    m.FPDFPageObj_Transform(t, dir[0], -dir[1], up[0], -up[1], ox, oy);
    this.insert(t);
  }

  /** Text frame for an item's upright content box. */
  private contentFrame(r: Rect & { rot: Rot }, u: number, v: number): { origin: [number, number]; dir: [number, number]; up: [number, number] } {
    const o = contentToPage(r, u, v);
    const a = contentToPage(r, u + 1, v);
    const b = contentToPage(r, u, v - 1);
    return { origin: o, dir: [a[0] - o[0], a[1] - o[1]], up: [b[0] - o[0], b[1] - o[1]] };
  }

  /** Text frame for upright text on the page as shown (handles page rotation). */
  private shownFrame(sx: number, sy: number): { origin: [number, number]; dir: [number, number]; up: [number, number] } {
    const o = toPage(this.e, sx, sy);
    const a = toPage(this.e, sx + 1, sy);
    const b = toPage(this.e, sx, sy - 1);
    return { origin: o, dir: [a[0] - o[0], a[1] - o[1]], up: [b[0] - o[0], b[1] - o[1]] };
  }

  ruling(): void {
    const lines = templateLines(this.e.template, this.e.w, this.e.h);
    if (!lines.length) return;
    const hex = `#${TEMPLATE_RGB.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    this.path(lines.map(([a, b, c, d]) => [[a, b], [c, d]]), { stroke: hex, width: 0.5 });
  }

  watermark(wm: Watermark): void {
    if (!wm.text) return;
    const { w: sw, h: sh } = shownSize(this.e);
    const width = measure(wm.text, 'sans', wm.size, true, false);
    const ang = wm.diagonal ? -Math.atan2(sh, sw) : 0;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    // Baseline start in shown space, centred on the page.
    // Glyph 'up' in shown space is (s, -c); the glyph middle sits 0.35 em above the baseline.
    const bx = sw / 2 - (width / 2) * c - wm.size * 0.35 * s;
    const by = sh / 2 - (width / 2) * s + wm.size * 0.35 * c;
    const o = toPage(this.e, bx, by);
    const a = toPage(this.e, bx + c, by + s);
    const b = toPage(this.e, bx + s, by - c);
    this.textRun(wm.text, 'sans', true, false, wm.size, wm.color, wm.opacity, o, [a[0] - o[0], a[1] - o[1]], [b[0] - o[0], b[1] - o[1]]);
  }

  headerFooter(hf: HeaderFooter, num: number, total: number, file: string): void {
    const { w: sw, h: sh } = shownSize(this.e);
    for (const slot of hfSlots(hf, sw, sh)) {
      const text = fillTokens(slot.text, num, total, file);
      const width = measure(text, 'sans', hf.size, false, false);
      const x = slot.align === 'left' ? slot.x : slot.align === 'center' ? slot.x - width / 2 : slot.x - width;
      const f = this.shownFrame(x, slot.y);
      this.textRun(text, 'sans', false, false, hf.size, hf.color, 1, f.origin, f.dir, f.up);
    }
  }

  item(it: Item): void {
    switch (it.type) {
      case 'ink':
        return this.ink(it);
      case 'text':
        return this.text(it);
      case 'mark':
        return this.mark(it);
      case 'shape':
        return this.shape(it);
      case 'note':
        return this.note(it);
      case 'stamp':
        return this.stamp(it);
      case 'image':
        return this.image(it);
      case 'markup':
        return this.markup(it);
      case 'link':
        return this.link(it.x, it.y, it.w, it.h, it.url);
      default:
        // Redaction marks are applied separately; hand-made fields go to the form step.
        return;
    }
  }

  text(t: TextItem): void {
    if (t.replace) return this.replaceText(t);
    if (!t.text.trim()) return;
    const lay = layoutText(t);
    const { w: cw, h: ch } = contentSize(t);
    if (t.cover) {
      const corners = [contentToPage(t, 0, 0), contentToPage(t, cw, 0), contentToPage(t, cw, ch), contentToPage(t, 0, ch)];
      this.path([corners], { fill: '#ffffff', closed: true });
    }
    lay.lines.forEach((line, i) => {
      let u = lay.padX;
      if (t.align && t.align !== 'left') {
        const free = cw - lay.padX * 2 - measure(line, t.font, t.size, t.bold, t.italic);
        u += t.align === 'center' ? free / 2 : free;
      }
      const f = this.contentFrame(t, u, lay.base + i * lay.lineH);
      this.textRun(line, t.font, t.bold, t.italic, t.size, t.color, 1, f.origin, f.dir, f.up);
    });
  }

  mark(mk: MarkItem): void {
    const s = Math.min(mk.w, mk.h);
    const x = mk.x + (mk.w - s) / 2;
    const y = mk.y + (mk.h - s) / 2;
    const width = Math.max(0.8, s * 0.14);
    if (mk.shape === 'dot') {
      const cx = x + s / 2;
      const cy = y + s / 2;
      const r = s * 0.27;
      this.path([Array.from({ length: 24 }, (_, k) => [cx + r * Math.cos((k / 24) * Math.PI * 2), cy + r * Math.sin((k / 24) * Math.PI * 2)] as [number, number])], { fill: mk.color, closed: true });
    } else if (mk.shape === 'cross') {
      this.path([[[x + s * 0.2, y + s * 0.2], [x + s * 0.8, y + s * 0.8]], [[x + s * 0.8, y + s * 0.2], [x + s * 0.2, y + s * 0.8]]], { stroke: mk.color, width, round: true });
    } else {
      this.path([CHECK_PATH.map(([u, v]) => [x + u * s, y + v * s] as [number, number])], { stroke: mk.color, width, round: true });
    }
  }

  stamp(st: StampItem): void {
    const lay = stampLayout(st);
    const { w: cw, h: ch } = contentSize(st);
    const bw = Math.max(1, Math.min(cw, ch) * 0.05);
    const r = Math.min(cw, ch) * 0.14;
    const pts: [number, number][] = [];
    const corner = (cx: number, cy: number, a0: number) => {
      for (let k = 0; k <= 6; k++) {
        const a = a0 + (k / 6) * (Math.PI / 2);
        pts.push(contentToPage(st, cx + r * Math.cos(a), cy + r * Math.sin(a)));
      }
    };
    const i = bw / 2;
    corner(cw - i - r, i + r, -Math.PI / 2);
    corner(cw - i - r, ch - i - r, 0);
    corner(i + r, ch - i - r, Math.PI / 2);
    corner(i + r, i + r, Math.PI);
    this.path([pts], { stroke: st.color, width: bw, closed: true, alpha: 0.9 });
    const mainBase = st.sub ? ch * 0.5 + lay.size * 0.2 : ch / 2 + lay.size * 0.35;
    const mw = measure(st.label, 'sans', lay.size, true, false);
    let f = this.contentFrame(st, (cw - mw) / 2, mainBase);
    this.textRun(st.label, 'sans', true, false, lay.size, st.color, 0.9, f.origin, f.dir, f.up);
    if (st.sub) {
      const sw = measure(st.sub, 'sans', lay.subSize, false, false);
      f = this.contentFrame(st, (cw - sw) / 2, mainBase + lay.subSize * 1.45);
      this.textRun(st.sub, 'sans', false, false, lay.subSize, st.color, 0.9, f.origin, f.dir, f.up);
    }
  }

  image(it: ImageItem): void {
    const img = images.get(it.image);
    if (!img) return;
    const m = this.m;
    const obj = m.FPDFPageObj_NewImageObj(this.doc);
    if (!obj) return;
    const ok = withBytes(img.bytes, (ptr, len) => (img.mime === 'image/jpeg' ? m.EPDFImageObj_SetJpeg(this.page, 0, obj, ptr, len) : m.EPDFImageObj_SetPng(this.page, 0, obj, ptr, len)));
    if (!ok) {
      m.FPDFPageObj_Destroy(obj);
      return;
    }
    const { w: cw, h: ch } = contentSize(it);
    const bl = this.u(...contentToPage(it, 0, ch));
    const br = this.u(...contentToPage(it, cw, ch));
    const tl = this.u(...contentToPage(it, 0, 0));
    const mat: Mat = [br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]];
    m.FPDFImageObj_SetMatrix(obj, ...mat);
    this.insert(obj);
  }

  // ---------- annotations ----------

  private annot(subtype: number, r: Rect, color: string, alpha: number, ap: string, flags = FLAG_PRINT): number {
    const m = this.m;
    const a = m.FPDFPage_CreateAnnot(this.page, subtype);
    if (!a) throw new Error('Could not add an annotation.');
    const [x0, y1] = this.u(r.x, r.y);
    const [x1, y0] = this.u(r.x + r.w, r.y + r.h);
    m.FPDFAnnot_SetFlags(a, flags);
    withWide('1', (ptr) => m.FPDFAnnot_SetStringValue(a, NIB_TAG, ptr));
    m.FPDFAnnot_SetColor(a, COLORTYPE_COLOR, ...hexToRgb(color), Math.round(alpha * 255));
    withFloats([x0, y1, x1, y0], (ptr) => m.FPDFAnnot_SetRect(a, ptr));
    if (ap) withWide(ap, (ptr) => m.FPDFAnnot_SetAP(a, APPEARANCE_NORMAL, ptr));
    return a;
  }

  private rg(color: string, op: 'rg' | 'RG'): string {
    const [r, g, b] = hexToRgb(color);
    return `${f2(r / 255)} ${f2(g / 255)} ${f2(b / 255)} ${op}`;
  }

  /** Polygon (page points) as a PDF path in user space. */
  private poly(pts: [number, number][]): string {
    return pts.map(([x, y], k) => `${f2(this.u(x, y)[0])} ${f2(this.u(x, y)[1])} ${k ? 'l' : 'm'}`).join(' ');
  }

  /**
   * Writes one stroke as a standard PDF ink annotation. The appearance stream
   * holds the exact filled outline (pressure-shaped, with the same curves as
   * on screen), and the ink list holds the centre line so other apps can
   * still edit or erase the stroke.
   */
  ink(s: InkItem): void {
    const poly = outline(s);
    if (poly.length < 3) return;
    const pts = poly.map(([x, y]) => this.u(x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const alpha = s.kind === 'highlighter' ? HIGHLIGHT_ALPHA : 1;
    // Quadratic curves through midpoints, written as cubic Béziers.
    let path = `${f2(pts[0][0])} ${f2(pts[0][1])} m`;
    let prev = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const c = pts[i];
      const end: [number, number] = [(c[0] + pts[i + 1][0]) / 2, (c[1] + pts[i + 1][1]) / 2];
      const c1 = [prev[0] + (2 / 3) * (c[0] - prev[0]), prev[1] + (2 / 3) * (c[1] - prev[1])];
      const c2 = [end[0] + (2 / 3) * (c[0] - end[0]), end[1] + (2 / 3) * (c[1] - end[1])];
      path += ` ${f2(c1[0])} ${f2(c1[1])} ${f2(c2[0])} ${f2(c2[1])} ${f2(end[0])} ${f2(end[1])} c`;
      prev = end;
    }
    path += ` ${f2(pts[pts.length - 1][0])} ${f2(pts[pts.length - 1][1])} l`;
    const gs = alpha < 1 ? '/GS gs ' : '';
    const ap = `q ${gs}${this.rg(s.color, 'rg')} ${path} h f Q`;
    const minX = Math.min(...xs) - 1;
    const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys) - 1;
    const maxY = Math.max(...ys) + 1;
    const r = { x: minX - this.box.left, y: this.box.top - maxY, w: maxX - minX, h: maxY - minY };
    const a = this.annot(ANNOT_INK, r, s.color, alpha, '');
    try {
      const m = this.m;
      m.FPDFAnnot_SetBorder(a, 0, 0, s.size);
      const centre = decimate(s.pts).flatMap(([x, y]) => this.u(x, y));
      withFloats(centre, (ptr) => m.FPDFAnnot_AddInkStroke(a, ptr, centre.length / 2));
      withWide(ap, (ptr) => m.FPDFAnnot_SetAP(a, APPEARANCE_NORMAL, ptr));
    } finally {
      this.m.FPDFPage_CloseAnnot(a);
    }
  }

  shape(s: ShapeItem): void {
    const x = Math.min(s.x1, s.x2);
    const y = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    const pad = s.width / 2 + (s.shape === 'arrow' ? s.width * 4 : 0) + 1;
    const r = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
    const head = `q ${f2(s.width)} w 1 J 1 j ${this.rg(s.color, 'RG')} `;
    let ap: string;
    let subtype = ANNOT_INK;
    if (s.shape === 'rect') {
      subtype = ANNOT_SQUARE;
      ap = `${head}${this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])} h S Q`;
    } else if (s.shape === 'ellipse') {
      subtype = ANNOT_CIRCLE;
      const pts = Array.from({ length: 48 }, (_, k) => [x + w / 2 + (w / 2) * Math.cos((k / 48) * Math.PI * 2), y + h / 2 + (h / 2) * Math.sin((k / 48) * Math.PI * 2)] as [number, number]);
      ap = `${head}${this.poly(pts)} h S Q`;
    } else {
      ap = `${head}${this.poly([[s.x1, s.y1], [s.x2, s.y2]])} S`;
      if (s.shape === 'arrow') ap += ` ${this.poly(arrowHead(s))} S`;
      ap += ' Q';
    }
    const a = this.annot(subtype, r, s.color, 1, '');
    try {
      const m = this.m;
      m.FPDFAnnot_SetBorder(a, 0, 0, s.width);
      if (subtype === ANNOT_INK) {
        const line = [...this.u(s.x1, s.y1), ...this.u(s.x2, s.y2)];
        withFloats(line, (ptr) => m.FPDFAnnot_AddInkStroke(a, ptr, 2));
      }
      withWide(ap, (ptr) => m.FPDFAnnot_SetAP(a, APPEARANCE_NORMAL, ptr));
    } finally {
      this.m.FPDFPage_CloseAnnot(a);
    }
  }

  note(n: NoteItem): void {
    const s = NOTE_SIZE;
    const body = this.poly([[n.x, n.y], [n.x + s, n.y], [n.x + s, n.y + s * 0.72], [n.x + s * 0.72, n.y + s], [n.x, n.y + s]]);
    const lines = [0.3, 0.5, 0.7].map((f) => this.poly([[n.x + s * 0.2, n.y + s * f], [n.x + s * (f === 0.7 ? 0.55 : 0.8), n.y + s * f]])).join(' ');
    const ap = `q ${this.rg(n.color, 'rg')} 0.3 0.3 0.3 RG 0.8 w ${body} h B ${lines} S Q`;
    const a = this.annot(ANNOT_TEXT, { x: n.x, y: n.y, w: s, h: s }, n.color, 1, ap, FLAG_PRINT | FLAG_NOZOOM | FLAG_NOROTATE);
    try {
      withWide(n.text, (ptr) => this.m.FPDFAnnot_SetStringValue(a, 'Contents', ptr));
    } finally {
      this.m.FPDFPage_CloseAnnot(a);
    }
  }

  markup(mk: MarkupItem): void {
    if (!mk.rects.length) return;
    const xs = mk.rects.flatMap((r) => [r.x, r.x + r.w]);
    const ys = mk.rects.flatMap((r) => [r.y, r.y + r.h]);
    const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const subtype = mk.kind === 'highlight' ? ANNOT_HIGHLIGHT : mk.kind === 'underline' ? ANNOT_UNDERLINE : ANNOT_STRIKEOUT;
    const alpha = mk.kind === 'highlight' ? 0.35 : 1;
    const parts = mk.rects.map((r) => {
      if (mk.kind === 'highlight') return this.poly([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) + ' h';
      const t = Math.max(0.6, r.h * 0.07);
      const y = mk.kind === 'underline' ? r.y + r.h - t * 1.5 : r.y + r.h * 0.55 - t / 2;
      return this.poly([[r.x, y], [r.x + r.w, y], [r.x + r.w, y + t], [r.x, y + t]]) + ' h';
    });
    const gs = alpha < 1 ? '/GS gs ' : '';
    const ap = `q ${gs}${this.rg(mk.color, 'rg')} ${parts.join(' ')} f Q`;
    const a = this.annot(subtype, bounds, mk.color, alpha, '');
    try {
      const m = this.m;
      for (const r of mk.rects) {
        const [x1, y1] = this.u(r.x, r.y);
        const [x2, y2] = this.u(r.x + r.w, r.y + r.h);
        // QuadPoints order used by Acrobat: upper-left, upper-right, lower-left, lower-right.
        withFloats([x1, y1, x2, y1, x1, y2, x2, y2], (ptr) => m.FPDFAnnot_AppendAttachmentPoints(a, ptr));
      }
      withWide(ap, (ptr) => m.FPDFAnnot_SetAP(a, APPEARANCE_NORMAL, ptr));
    } finally {
      this.m.FPDFPage_CloseAnnot(a);
    }
  }

  link(x: number, y: number, w: number, h: number, url: string): void {
    const m = this.m;
    const a = this.annot(ANNOT_LINK, { x, y, w, h }, '#2f3fd6', 1, '', 0);
    try {
      m.FPDFAnnot_SetBorder(a, 0, 0, 0);
      const bytes = new TextEncoder().encode(url + '\0');
      const ptr = malloc(bytes.length);
      try {
        heap().set(bytes, ptr);
        m.FPDFAnnot_SetURI(a, ptr);
      } finally {
        free(ptr);
      }
    } finally {
      m.FPDFPage_CloseAnnot(a);
    }
  }
}
