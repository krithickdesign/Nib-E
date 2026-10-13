// Turns detected boxes into real form fields ("Make fillable"). Uses pdf-lib
// because it builds correct radio groups (one field, several buttons).
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { FontFamily } from './core';

export interface OutField {
  page: number;
  kind: 'text' | 'check' | 'radio';
  /** PDF user space, origin bottom-left. */
  rect: { x: number; y: number; w: number; h: number };
  name: string;
  value: string;
  checked: boolean;
  group?: string;
  option?: string;
  font: FontFamily;
  size: number;
  multiline?: boolean;
}

function cleanName(s: string): string {
  // Dots separate levels in PDF field names, so they cannot appear in a name.
  return s.replace(/\./g, '').replace(/\s+/g, ' ').replace(/[:*]+$/, '').trim().slice(0, 80) || 'Field';
}

export async function addFillableFields(bytes: Uint8Array, fields: OutField[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  const pages = pdf.getPages();
  const fonts = new Map<FontFamily, PDFFont>();
  const fontFor = async (f: FontFamily) => {
    let font = fonts.get(f);
    if (!font) {
      font = await pdf.embedFont(f === 'serif' ? StandardFonts.TimesRoman : f === 'mono' ? StandardFonts.Courier : StandardFonts.Helvetica);
      fonts.set(f, font);
    }
    return font;
  };
  const used = new Set(form.getFields().map((f) => f.getName()));
  const unique = (base: string) => {
    let name = cleanName(base);
    let n = 2;
    while (used.has(name)) name = `${cleanName(base)} (${n++})`;
    used.add(name);
    return name;
  };
  const clear = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 };

  const groups = new Map<string, OutField[]>();
  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const at = { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h };
    if (f.kind === 'text') {
      const font = await fontFor(f.font);
      const tf = form.createTextField(unique(f.name));
      if (f.multiline) tf.enableMultiline();
      tf.addToPage(page, { ...at, ...clear, font, textColor: rgb(0.1, 0.12, 0.18) });
      tf.setFontSize(f.size);
      if (f.value) tf.setText(f.value);
      tf.updateAppearances(font);
    } else if (f.kind === 'check') {
      const cb = form.createCheckBox(unique(f.option ? `${f.name} ${f.option}` : f.name));
      cb.addToPage(page, { ...at, ...clear, textColor: rgb(0.1, 0.12, 0.18) });
      if (f.checked) cb.check();
    } else {
      const key = f.group ?? `${f.page}:${f.rect.x}:${f.rect.y}`;
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }
  }

  for (const list of groups.values()) {
    const rg = form.createRadioGroup(unique(list[0].name || 'Choice'));
    const opts = new Set<string>();
    list.forEach((f, k) => {
      let opt = cleanName(f.option || `Option ${k + 1}`);
      while (opts.has(opt)) opt += ' ';
      opts.add(opt);
      rg.addOptionToPage(opt, pages[f.page], { x: f.rect.x, y: f.rect.y, width: f.rect.w, height: f.rect.h, ...clear, textColor: rgb(0.1, 0.12, 0.18) });
      if (f.checked) rg.select(opt);
    });
  }

  return pdf.save({ useObjectStreams: false });
}
