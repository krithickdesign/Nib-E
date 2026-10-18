// Copies the single-file app into dist-desktop/ for the Tauri desktop build.
// The web copy's security tag is removed: the app sets its own (tauri.conf.json),
// which also allows talking to the app itself (ipc:).
// The PDF engine (pdfium.wasm, about 4 MB) is stored as its own file instead of
// inside the page as text: the page gets smaller and starts faster, which matters
// most on slower web views (Linux WebKitGTK).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist-desktop', { recursive: true });
let html = readFileSync('dist-single/index.html', 'utf8').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*data-nib-csp[^>]*>/, '');
const re = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/;
const m = html.match(re);
if (!m) throw new Error('pdfium.wasm was not found inside dist-single/index.html');
writeFileSync('dist-desktop/pdfium.wasm', Buffer.from(m[1], 'base64'));
html = html.replace(re, 'pdfium.wasm');
if (re.test(html)) throw new Error('more than one inlined wasm file');
writeFileSync('dist-desktop/index.html', html);
console.log(`dist-desktop/index.html updated (${(html.length / 1048576).toFixed(1)} MB), pdfium.wasm separate`);
// Text recognition files (only the fast SIMD engine: every supported web view has SIMD).
execFileSync(process.execPath, ['scripts/copy-ocr.mjs', 'dist-desktop', '--simd-only'], { stdio: 'inherit' });
