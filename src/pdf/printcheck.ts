// Print check ("preflight light"): what a print shop would look at first.
// Fonts not embedded, low-resolution images, colour spaces, trim and bleed
// boxes, transparency and page sizes. Read-only, all offline.
import { free, heap, malloc, mul, objBounds, objMatrix, openRaw, pdfium, readFloats, type Mat } from './core';

export type PrintLevel = 'ok' | 'note' | 'warn';

export interface PrintFinding {
  id: string;
  level: PrintLevel;
  title: string;
  detail: string;
  /** 1-based page numbers it concerns (first few). */
  pages?: number[];
}

export interface PrintReport {
  pages: number;
  checkedPages: number;
  findings: PrintFinding[];
}

const OBJ_TEXT = 1;
const OBJ_IMAGE = 3;
const OBJ_FORM = 5;
const MAX_PAGES = 400;
const PT_PER_MM = 72 / 25.4;
const STANDARD_14 = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats']);

// FPDF_IMAGEOBJ_METADATA: width, height (uint), horizontal_dpi, vertical_dpi (float), bits_per_pixel (uint), colorspace (int), marked_content_id (int)
const COLORSPACES = ['Unknown', 'Gray', 'RGB', 'CMYK', 'Gray', 'RGB', 'Lab', 'ICC', 'Spot colour', 'Spot colours', 'Indexed', 'Pattern'];

function cstr(fn: (buf: number, len: number) => number): string {
  const need = fn(0, 0);
  if (need <= 0) return '';
  const p = malloc(need);
  try {
    fn(p, need);
    let s = '';
    const h = heap();
    for (let i = p; i < p + need && h[i]; i++) s += String.fromCharCode(h[i]);
    return s;
  } finally {
    free(p);
  }
}

const pageList = (set: Set<number>) => [...set].sort((a, b) => a - b).slice(0, 8);
const listText = (pages: number[], total: number) => (total > pages.length ? `${pages.join(', ')} and more` : pages.join(', '));

export function printCheck(bytes: Uint8Array, password = ''): PrintReport {
  const m = pdfium();
  const raw = openRaw(bytes, password);
  try {
    const D = raw.doc;
    const pageCount = m.FPDF_GetPageCount(D);
    const n = Math.min(pageCount, MAX_PAGES);
    const missingFonts = new Map<string, Set<number>>();
    const lowImages = { warn: new Set<number>(), note: new Set<number>(), count: 0, minDpi: Infinity };
    const spaces = new Map<string, number>();
    const transparent = new Set<number>();
    const sizes = new Map<string, number>();
    let noTrim = 0;
    let noBleed = 0;
    let images = 0;
    const meta = malloc(28);
    const box = malloc(16);
    const wh = malloc(8);
    try {
      for (let i = 0; i < n; i++) {
        const page = m.FPDF_LoadPage(D, i);
        if (!page) continue;
        try {
          const w = m.FPDF_GetPageWidthF(page);
          const h = m.FPDF_GetPageHeightF(page);
          const key = `${Math.round(w / PT_PER_MM)} × ${Math.round(h / PT_PER_MM)} mm`;
          sizes.set(key, (sizes.get(key) ?? 0) + 1);
          const hasTrim = m.FPDFPage_GetTrimBox(page, box, box + 4, box + 8, box + 12);
          const trim = hasTrim ? readFloats(box, 4) : null;
          const hasBleed = m.FPDFPage_GetBleedBox(page, box, box + 4, box + 8, box + 12);
          const bleed = hasBleed ? readFloats(box, 4) : null;
          if (!trim) noTrim++;
          else if (!bleed || Math.min(trim[0] - bleed[0], trim[1] - bleed[1], bleed[2] - trim[2], bleed[3] - trim[3]) < 2.5 * PT_PER_MM) noBleed++;

          const walk = (count: number, get: (k: number) => number, parent: Mat | null, depth: number) => {
            for (let k = 0; k < count; k++) {
              const obj = get(k);
              if (!obj) continue;
              const type = m.FPDFPageObj_GetType(obj);
              if (m.FPDFPageObj_HasTransparency(obj)) transparent.add(i + 1);
              if (type === OBJ_TEXT) {
                const font = m.FPDFTextObj_GetFont(obj);
                if (font && !m.FPDFFont_GetIsEmbedded(font)) {
                  const name = cstr((b, l) => m.FPDFFont_GetBaseFontName(font, b, l)) || 'Unnamed font';
                  let set = missingFonts.get(name);
                  if (!set) missingFonts.set(name, (set = new Set()));
                  set.add(i + 1);
                }
              } else if (type === OBJ_IMAGE) {
                images++;
                if (!m.FPDFImageObj_GetImagePixelSize(obj, wh, wh + 4)) continue;
                const [pw, ph] = Array.from(new Uint32Array(heap().buffer.slice(wh, wh + 8)));
                const [l, b, r, t] = objBounds(obj, parent);
                const inchW = (r - l) / 72;
                const inchH = (t - b) / 72;
                if (inchW < 0.2 || inchH < 0.2 || pw < 2 || ph < 2) continue; // tiny marks and lines
                const dpi = Math.min(pw / inchW, ph / inchH);
                lowImages.minDpi = Math.min(lowImages.minDpi, dpi);
                if (dpi < 150) {
                  lowImages.warn.add(i + 1);
                  lowImages.count++;
                } else if (dpi < 250) {
                  lowImages.note.add(i + 1);
                  lowImages.count++;
                }
                if (m.FPDFImageObj_GetImageMetadata(obj, page, meta)) {
                  const cs = new Int32Array(heap().buffer.slice(meta + 20, meta + 24))[0];
                  const label = COLORSPACES[cs] ?? 'Unknown';
                  spaces.set(label, (spaces.get(label) ?? 0) + 1);
                }
              } else if (type === OBJ_FORM && depth < 6) {
                const mat = parent ? mul(objMatrix(obj), parent) : objMatrix(obj);
                walk(m.FPDFFormObj_CountObjects(obj), (j) => m.FPDFFormObj_GetObject(obj, j), mat, depth + 1);
              }
            }
          };
          walk(m.FPDFPage_CountObjects(page), (k) => m.FPDFPage_GetObject(page, k), null, 0);
        } finally {
          m.FPDF_ClosePage(page);
        }
      }
    } finally {
      free(meta);
      free(box);
      free(wh);
    }

    const findings: PrintFinding[] = [];
    const std = [...missingFonts.keys()].filter((k) => STANDARD_14.has(k.replace(/^[A-Z]{6}\+/, '')));
    for (const k of std) missingFonts.delete(k);
    if (std.length)
      findings.push({
        id: 'stdfonts',
        level: 'note',
        title: 'Standard PDF fonts not embedded',
        detail: `${std.join(', ')}. Every printer and reader has these, so this is normally fine. Some print shops still ask for every font to be embedded.`,
      });
    if (missingFonts.size) {
      const names = [...missingFonts.keys()];
      const pages = new Set([...missingFonts.values()].flatMap((s) => [...s]));
      findings.push({
        id: 'fonts',
        level: 'warn',
        title: `${names.length} font${names.length === 1 ? '' : 's'} not embedded`,
        detail: `${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}. The printer may swap in a different font. Ask for a file with embedded fonts, or print the page as an image (Export → Images, 300 dpi).`,
        pages: pageList(pages),
      });
    } else if (!std.length) findings.push({ id: 'fonts', level: 'ok', title: 'All fonts embedded', detail: 'Text prints with the fonts it was made with.' });

    if (!images) findings.push({ id: 'images', level: 'ok', title: 'No images', detail: 'Nothing can print blurry.' });
    else if (lowImages.warn.size)
      findings.push({
        id: 'images',
        level: 'warn',
        title: 'Low-resolution images',
        detail: `The lowest is about ${Math.round(lowImages.minDpi)} dpi at its printed size. Below 150 dpi looks blurry on paper; 300 dpi is the usual target for print.`,
        pages: pageList(lowImages.warn),
      });
    else if (lowImages.note.size)
      findings.push({
        id: 'images',
        level: 'note',
        title: 'Some images under 250 dpi',
        detail: `The lowest is about ${Math.round(lowImages.minDpi)} dpi. Fine for office printers; a print shop usually asks for 300 dpi.`,
        pages: pageList(lowImages.note),
      });
    else findings.push({ id: 'images', level: 'ok', title: `${images} image${images === 1 ? '' : 's'}, all sharp enough`, detail: `Every image has at least 250 dpi at its printed size (lowest about ${Math.round(lowImages.minDpi)} dpi).` });

    if (spaces.size) {
      const list = [...spaces.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v} image${v === 1 ? '' : 's'}`).join(', ');
      const rgb = (spaces.get('RGB') ?? 0) + (spaces.get('ICC') ?? 0);
      findings.push({
        id: 'colour',
        level: rgb ? 'note' : 'ok',
        title: rgb ? 'Images in RGB' : 'Image colours',
        detail: `${list}.${rgb ? ' Print shops convert RGB to CMYK, so bright colours can look duller on paper. Ask the shop whether they want CMYK.' : ''}`,
      });
    }

    if (noTrim === n) findings.push({ id: 'boxes', level: 'note', title: 'No trim or bleed set', detail: 'Fine for office printing. For printing to the edge, a print shop needs 3 mm of bleed (extra picture around the page) and a trim box.' });
    else if (noTrim || noBleed) findings.push({ id: 'boxes', level: 'note', title: 'Bleed missing on some pages', detail: `${noTrim + noBleed} page${noTrim + noBleed === 1 ? ' has' : 's have'} no trim box or less than 3 mm bleed.` });
    else findings.push({ id: 'boxes', level: 'ok', title: 'Trim and bleed set', detail: 'Every page has a trim box and at least 3 mm bleed.' });

    if (transparent.size)
      findings.push({
        id: 'transparency',
        level: 'note',
        title: 'Transparency used',
        detail: 'Most printers handle it. Very old print workflows (PDF/X-1a) need it flattened first.',
        pages: pageList(transparent),
      });

    if (sizes.size > 1)
      findings.push({ id: 'sizes', level: 'note', title: 'Mixed page sizes', detail: [...sizes.entries()].map(([k, v]) => `${v} × ${k}`).join(', ') + '.' });
    else if (sizes.size) findings.push({ id: 'sizes', level: 'ok', title: 'Page size', detail: `${[...sizes.keys()][0]} on every page.` });

    return { pages: pageCount, checkedPages: n, findings };
  } finally {
    raw.close();
  }
}

export { listText };
