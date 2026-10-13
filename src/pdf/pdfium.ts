// Loads the PDF engine (PDFium, the engine inside Chrome, as WebAssembly).
// Low-level helpers live in core.ts so they can also run in Node tests.
import { init } from '@embedpdf/pdfium';
import { PdfiumNative } from '@embedpdf/engines/pdfium';
import type { PdfDocumentObject } from '@embedpdf/models';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { pdfium, setPdfium } from './core';

export * from './core';

let eng: PdfiumNative | null = null;

/** Turns a URL into bytes. Data URLs are decoded by hand so no network call is needed. */
export async function urlToBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    if (meta.endsWith(';base64')) {
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function startPdfium(): Promise<void> {
  if (eng) return;
  const wasmBinary = await urlToBytes(wasmUrl);
  const m = await init({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
  setPdfium(m);
  // The engine constructor also calls PDFiumExt_Init.
  eng = new PdfiumNative(m);
  void pdfium();
}

export function engine(): PdfiumNative {
  if (!eng) throw new Error('PDF engine not started');
  return eng;
}

/** Current bytes of an engine-held document, including filled form values. */
export async function engineBytes(doc: PdfDocumentObject): Promise<Uint8Array> {
  const buf = await engine().saveAsCopy(doc).toPromise();
  return new Uint8Array(buf as ArrayBuffer);
}
