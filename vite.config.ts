import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

// The PDFium glue code points at its own copy of pdfium.wasm. Nib passes the
// wasm bytes in directly, so drop that reference to avoid bundling it twice.
function dropDuplicateWasm(): Plugin {
  return {
    name: 'nib:drop-duplicate-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@embedpdf/pdfium/dist/index.browser.js')) return null;
      return code.replace("new URL('pdfium.wasm', import.meta.url).href", "'pdfium.wasm'");
    },
  };
}

// Every supported browser reads woff2; skip the older woff fallback files.
function woff2Only(): Plugin {
  return {
    name: 'nib:woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
    },
  };
}

// Dev server: serve the text recognition files from node_modules at /ocr/.
// (Builds copy them with scripts/copy-ocr.mjs.)
function ocrFiles(): Plugin {
  const map: Record<string, string> = {
    'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
    'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
    'eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
    'deu.traineddata.gz': 'node_modules/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz',
  };
  return {
    name: 'nib:ocr-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/ocr/', (req, res, next) => {
        const file = map[(req.url ?? '').replace(/^\//, '').split('?')[0]];
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
  };
}

// `npm run build`        -> dist/ (normal multi-file web app; also what a desktop wrapper loads)
// `npm run build:single` -> dist-single/index.html (everything inlined in one file)
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: [dropDuplicateWasm(), woff2Only(), ocrFiles(), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    assetsInclude: ['**/*.wasm', '**/*.pdf'],
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 8000,
      reportCompressedSize: false,
    },
    optimizeDeps: { exclude: ['@embedpdf/pdfium'] },
  };
});
