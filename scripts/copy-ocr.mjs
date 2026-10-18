// Copies the text recognition files (Tesseract) next to the app:
//   node scripts/copy-ocr.mjs <folder> [--simd-only]
// They are loaded only when someone uses Text recognition, from the same place
// as the app itself (no other website). About 12 MB, or 8 MB with --simd-only.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dest = process.argv[2];
if (!dest) throw new Error('usage: node scripts/copy-ocr.mjs <folder> [--simd-only]');
const simdOnly = process.argv.includes('--simd-only');
const out = join(dest, 'ocr');
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ...(simdOnly ? [] : [['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']]),
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ['node_modules/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz', 'deu.traineddata.gz'],
];
for (const [from, to] of files) copyFileSync(from, join(out, to));
writeFileSync(
  join(out, 'LICENSES.txt'),
  'Text recognition in Nib-E uses Tesseract OCR (Apache License 2.0, https://github.com/tesseract-ocr/tesseract),\n' +
    'tesseract.js and tesseract.js-core (Apache License 2.0, https://github.com/naptha/tesseract.js),\n' +
    'and the tessdata_best language data for English and German (Apache License 2.0, https://github.com/tesseract-ocr/tessdata_best).\n',
);
console.log(`${out}: text recognition files copied${simdOnly ? ' (SIMD only)' : ''}`);
