// Copies the single-file app into dist-desktop/ for the Tauri desktop build.
// The web copy's security tag is removed: the app sets its own (tauri.conf.json),
// which also allows talking to the app itself (ipc:).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist-desktop', { recursive: true });
const html = readFileSync('dist-single/index.html', 'utf8').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*data-nib-csp[^>]*>/, '');
writeFileSync('dist-desktop/index.html', html);
console.log('dist-desktop/index.html updated');
