// Export pages as images, and build a PDF from images.
import { zipSync } from 'fflate';
import { newRawDoc, openRaw, pdfium, saveRaw, withBytes } from './core';
import { encode, renderPage, type Raster } from './raster';

function rotateRaster(r: Raster, quarter: number): Raster {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return r;
  const w = q % 2 ? r.h : r.w;
  const h = q % 2 ? r.w : r.h;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      let nx: number, ny: number;
      if (q === 1) [nx, ny] = [r.h - 1 - y, x];
      else if (q === 2) [nx, ny] = [r.w - 1 - x, r.h - 1 - y];
      else [nx, ny] = [y, r.w - 1 - x];
      const s = (y * r.w + x) * 4;
      const d = (ny * w + nx) * 4;
      out[d] = r.data[s];
      out[d + 1] = r.data[s + 1];
      out[d + 2] = r.data[s + 2];
      out[d + 3] = r.data[s + 3];
    }
  return { data: out, w, h };
}

export interface ImageFile {
  name: string;
  bytes: Uint8Array;
}

/** Renders the given pages of a PDF to PNG or JPEG files (as shown, i.e. with rotation). */
export async function pagesToImages(pdf: Uint8Array, indices: number[], dpi: number, mime: 'image/png' | 'image/jpeg', base: string, onProgress?: (k: number, n: number) => void): Promise<ImageFile[]> {
  const m = pdfium();
  const raw = openRaw(pdf);
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const files: ImageFile[] = [];
  try {
    for (let k = 0; k < indices.length; k++) {
      onProgress?.(k, indices.length);
      const i = indices[k];
      const page = m.FPDF_LoadPage(raw.doc, i);
      const rot = page ? m.FPDFPage_GetRotation(page) : 0;
      if (page) m.FPDF_ClosePage(page);
      const img = rotateRaster(renderPage(raw.doc, i, dpi / 72), rot);
      files.push({ name: `${base} - page ${String(i + 1).padStart(String(indices.length).length, '0')}.${ext}`, bytes: await encode(img, mime, 0.9) });
    }
  } finally {
    raw.close();
  }
  return files;
}

export function zip(files: ImageFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])));
}

export interface PageImage {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  w: number;
  h: number;
}

const A4: [number, number] = [595.28, 841.89];

/** One page per image. 'a4' fits each image on an A4 page (turned to match), 'fit' makes the page the image size. */
export function imagesToPdf(list: PageImage[], size: 'a4' | 'fit'): Uint8Array {
  const m = pdfium();
  const doc = newRawDoc();
  try {
    list.forEach((img, i) => {
      let pw: number, ph: number, iw: number, ih: number, ix: number, iy: number;
      if (size === 'fit') {
        // 96 pixels per inch, so screenshots come out at their on-screen size.
        pw = iw = (img.w * 72) / 96;
        ph = ih = (img.h * 72) / 96;
        ix = iy = 0;
      } else {
        const landscape = img.w > img.h;
        [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
        const margin = 18;
        const s = Math.min((pw - margin * 2) / img.w, (ph - margin * 2) / img.h);
        iw = img.w * s;
        ih = img.h * s;
        ix = (pw - iw) / 2;
        iy = (ph - ih) / 2;
      }
      const page = m.FPDFPage_New(doc.doc, i, pw, ph);
      try {
        const obj = m.FPDFPageObj_NewImageObj(doc.doc);
        const ok = withBytes(img.bytes, (ptr, len) => (img.mime === 'image/jpeg' ? m.EPDFImageObj_SetJpeg(page, 0, obj, ptr, len) : m.EPDFImageObj_SetPng(page, 0, obj, ptr, len)));
        if (!ok) throw new Error(`Image ${i + 1} could not be added.`);
        m.FPDFImageObj_SetMatrix(obj, iw, 0, 0, ih, ix, iy);
        m.FPDFPage_InsertObject(page, obj);
        m.FPDFPage_GenerateContent(page);
      } finally {
        m.FPDF_ClosePage(page);
      }
    });
    return saveRaw(doc.doc);
  } finally {
    doc.close();
  }
}
