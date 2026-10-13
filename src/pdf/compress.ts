// Makes PDFs smaller by downsampling large photos to a target resolution and
// re-saving them as JPEG. Images with transparency are left alone (JPEG has
// no alpha), and the original is kept if the result is not smaller.
import { free, heap, IDENTITY, malloc, mul, objBounds, objMatrix, openRaw, pdfium, readU32, saveRaw, withBytes, type Mat } from './core';

export interface CompressOptions {
  dpi: number;
  quality: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  images: number;
}

const OBJ_IMAGE = 3;
const OBJ_FORM = 5;

function filterName(obj: number): string {
  const m = pdfium();
  const n = m.FPDFImageObj_GetImageFilterCount(obj);
  if (n < 1) return '';
  const buf = malloc(64);
  try {
    const len = m.FPDFImageObj_GetImageFilter(obj, n - 1, buf, 64);
    return len > 1 ? new TextDecoder().decode(heap().slice(buf, buf + len - 1)) : '';
  } finally {
    free(buf);
  }
}

function hasTransparency(doc: number, page: number, obj: number): boolean {
  const m = pdfium();
  const bmp = m.FPDFImageObj_GetRenderedBitmap(doc, page, obj);
  if (!bmp) return true;
  try {
    if (m.FPDFBitmap_GetFormat(bmp) !== 4) return false;
    const w = m.FPDFBitmap_GetWidth(bmp);
    const h = m.FPDFBitmap_GetHeight(bmp);
    const stride = m.FPDFBitmap_GetStride(bmp);
    const buf = m.FPDFBitmap_GetBuffer(bmp);
    const px = heap();
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (px[buf + y * stride + x * 4 + 3] < 250) return true;
    return false;
  } finally {
    m.FPDFBitmap_Destroy(bmp);
  }
}

/** The image's own pixels as RGBA (without masks). */
function imagePixels(obj: number): { data: Uint8ClampedArray; w: number; h: number } | null {
  const m = pdfium();
  const bmp = m.FPDFImageObj_GetBitmap(obj);
  if (!bmp) return null;
  try {
    const w = m.FPDFBitmap_GetWidth(bmp);
    const h = m.FPDFBitmap_GetHeight(bmp);
    const stride = m.FPDFBitmap_GetStride(bmp);
    const fmt = m.FPDFBitmap_GetFormat(bmp);
    const buf = m.FPDFBitmap_GetBuffer(bmp);
    const bpp = fmt === 1 ? 1 : fmt === 2 ? 3 : 4;
    const px = heap();
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = buf + y * stride;
      for (let x = 0; x < w; x++) {
        const o = row + x * bpp;
        const k = (y * w + x) * 4;
        if (bpp === 1) out[k] = out[k + 1] = out[k + 2] = px[o];
        else {
          out[k] = px[o + 2];
          out[k + 1] = px[o + 1];
          out[k + 2] = px[o];
        }
        out[k + 3] = 255;
      }
    }
    return { data: out, w, h };
  } finally {
    m.FPDFBitmap_Destroy(bmp);
  }
}

async function toJpeg(src: { data: Uint8ClampedArray; w: number; h: number }, scale: number, quality: number): Promise<Uint8Array> {
  const c1 = new OffscreenCanvas(src.w, src.h);
  c1.getContext('2d')!.putImageData(new ImageData(src.data as unknown as Uint8ClampedArray<ArrayBuffer>, src.w, src.h), 0, 0);
  const w = Math.max(1, Math.round(src.w * scale));
  const h = Math.max(1, Math.round(src.h * scale));
  const c2 = new OffscreenCanvas(w, h);
  const ctx = c2.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c1, 0, 0, w, h);
  const blob = await c2.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function compressPdf(bytes: Uint8Array, opts: CompressOptions, onProgress?: (page: number, pages: number) => void): Promise<CompressResult> {
  const m = pdfium();
  const raw = openRaw(bytes);
  let count = 0;
  try {
    const pages = m.FPDF_GetPageCount(raw.doc);
    const seen = new Set<number>();
    const size = malloc(8);
    try {
      for (let i = 0; i < pages; i++) {
        onProgress?.(i, pages);
        const page = m.FPDF_LoadPage(raw.doc, i);
        if (!page) continue;
        let changed = false;
        const visit = async (obj: number, parent: Mat | null, depth: number) => {
          const type = m.FPDFPageObj_GetType(obj);
          if (type === OBJ_FORM && depth < 4) {
            const fm = parent ? mul(objMatrix(obj), parent) : objMatrix(obj);
            const n = m.FPDFFormObj_CountObjects(obj);
            for (let k = 0; k < n; k++) await visit(m.FPDFFormObj_GetObject(obj, k), fm, depth + 1);
            return;
          }
          if (type !== OBJ_IMAGE || seen.has(obj)) return;
          seen.add(obj);
          if (!m.FPDFImageObj_GetImagePixelSize(obj, size, size + 4)) return;
          const [pw, ph] = readU32(size, 2);
          if (pw * ph < 60_000) return;
          const [l, b, r, t] = objBounds(obj, parent ?? IDENTITY);
          const dispW = Math.max(1, r - l);
          const dispH = Math.max(1, t - b);
          const dpi = Math.max(pw / (dispW / 72), ph / (dispH / 72));
          const scale = Math.min(1, opts.dpi / dpi);
          const isJpeg = /DCT/i.test(filterName(obj));
          if (isJpeg && scale > 0.85) return;
          if (hasTransparency(raw.doc, page, obj)) return;
          const px = imagePixels(obj);
          if (!px) return;
          const jpeg = await toJpeg(px, scale, opts.quality);
          const ok = withBytes(jpeg, (ptr, len) => m.EPDFImageObj_SetJpeg(page, 0, obj, ptr, len));
          if (ok) {
            changed = true;
            count++;
          }
        };
        const n = m.FPDFPage_CountObjects(page);
        for (let k = 0; k < n; k++) await visit(m.FPDFPage_GetObject(page, k), null, 0);
        if (changed) m.FPDFPage_GenerateContent(page);
        m.FPDF_ClosePage(page);
      }
    } finally {
      free(size);
    }
    const out = saveRaw(raw.doc);
    if (out.length >= bytes.length) return { bytes, before: bytes.length, after: bytes.length, images: 0 };
    return { bytes: out, before: bytes.length, after: out.length, images: count };
  } finally {
    raw.close();
  }
}
