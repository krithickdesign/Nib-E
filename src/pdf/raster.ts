// Page and image rasterising helpers shared by redaction, compression and
// export-as-images.
import { free, heap, malloc, pdfium } from './core';

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_PRINTING = 0x800;

export interface Raster {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/** Renders page `index` of a raw document without its /Rotate, as RGBA. */
export function renderPage(doc: number, index: number, scale: number, withAnnots = true): Raster {
  const m = pdfium();
  const page = m.EPDF_LoadPageNormalized(doc, index, 0);
  if (!page) throw new Error(`Could not open page ${index + 1}.`);
  try {
    const pw = m.FPDF_GetPageWidthF(page);
    const ph = m.FPDF_GetPageHeightF(page);
    const w = Math.max(1, Math.round(pw * scale));
    const h = Math.max(1, Math.round(ph * scale));
    const bmp = m.FPDFBitmap_CreateEx(w, h, 4, 0, 0);
    if (!bmp) throw new Error('Not enough memory to render this page.');
    const mat = malloc(24);
    const clip = malloc(16);
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
      new Float32Array(heap().buffer, mat, 6).set([scale, 0, 0, scale, 0, 0]);
      new Float32Array(heap().buffer, clip, 4).set([0, 0, w, h]);
      m.FPDF_RenderPageBitmapWithMatrix(bmp, page, mat, clip, (withAnnots ? FPDF_ANNOT : 0) | FPDF_REVERSE_BYTE_ORDER | FPDF_PRINTING);
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      const stride = m.FPDFBitmap_GetStride(bmp);
      const data = new Uint8ClampedArray(w * h * 4);
      const px = heap();
      for (let y = 0; y < h; y++) data.set(px.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
      return { data, w, h };
    } finally {
      free(mat);
      free(clip);
      m.FPDFBitmap_Destroy(bmp);
    }
  } finally {
    m.FPDF_ClosePage(page);
  }
}

export async function encode(r: Raster, mime: 'image/jpeg' | 'image/png', quality = 0.88): Promise<Uint8Array> {
  const c = new OffscreenCanvas(r.w, r.h);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  const blob = await c.convertToBlob({ type: mime, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Turns any image the browser can decode into JPEG or PNG bytes (keeps JPEG/PNG as is). */
export async function normaliseImage(file: Blob): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' | 'image/png'; w: number; h: number; bitmap: ImageBitmap }> {
  const bitmap = await createImageBitmap(file);
  const raw = new Uint8Array(await file.arrayBuffer());
  const isJpeg = raw[0] === 0xff && raw[1] === 0xd8;
  const isPng = raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
  if (isJpeg || isPng) return { bytes: raw, mime: isJpeg ? 'image/jpeg' : 'image/png', w: bitmap.width, h: bitmap.height, bitmap };
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d')!.drawImage(bitmap, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', w: bitmap.width, h: bitmap.height, bitmap };
}
