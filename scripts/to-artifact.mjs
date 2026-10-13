// Turns dist-single/index.html into a page fragment for a claude.ai artifact:
// title and styles first, then the body markup, then the inlined script.
// (The artifact host adds its own <html>, <head> and <body> wrapper.)
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('dist-single/index.html', 'utf8');
const title = src.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>Nib-E PDF Editor</title>';
const head = src.slice(src.indexOf('<head>') + 6, src.indexOf('</head>'));
const body = src.slice(src.indexOf('<body>') + 6, src.lastIndexOf('</body>'));
const styles = [...head.matchAll(/<style[\s\S]*?<\/style>/g)].map((m) => m[0]);
const scripts = [...head.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0]);
// Some libraries contain a literal U+FFFD inside JS template strings. Write it as
// the escape \uFFFD instead (same value), because some hosts reject the raw character.
const out = [title, ...styles, body.trim(), ...scripts].join('\n').replaceAll('\uFFFD', '\\uFFFD');
writeFileSync('dist-single/nib-artifact.html', out);
console.log(`dist-single/nib-artifact.html  ${(out.length / 1024 / 1024).toFixed(2)} MB`);

// Web and offline copies: security rules that allow no network requests at all.
// Nib-E needs none: the PDF engine, fonts and pictures are all inside the file.
// (The desktop build removes this tag; the app sets its own rules, see tauri.conf.json.)
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'connect-src data: blob:',
  'worker-src blob:',
  'media-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const withCsp = src.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" data-nib-csp />`);
writeFileSync('dist-single/index.html', withCsp);

// The same single file, named for people: double-click it to run Nib-E offline.
copyFileSync('dist-single/index.html', 'dist-single/Nib-E.html');
console.log('dist-single/Nib-E.html  (double-click to open)');
