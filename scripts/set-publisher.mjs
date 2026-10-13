// Sets the name Nib-E is published under, everywhere it is written down.
//   npm run publisher:set -- "Axiomate Technologies"
// package.json ("nibPublisher") is the source; the app reads it from there.
// Also updated: desktop installer details (tauri.conf.json, Cargo.toml) and the
// website (<span data-nib-publisher>…</span> in docs/index.html and docs/legal.html).
// Not updated here (do it by hand): Partner Center's publisher display name and
// the GitHub variable MSIX_PUBLISHER_NAME, which must match it exactly.
import { readFileSync, writeFileSync } from 'node:fs';

const name = (process.argv[2] ?? '').trim();
if (!name || /[<>"]/.test(name)) {
  console.error('Give a name, e.g.: npm run publisher:set -- "Axiomate Technologies"');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const old = pkg.nibPublisher;
pkg.nibPublisher = name;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
conf.bundle.publisher = name;
conf.bundle.copyright = `© ${name} · MIT License`;
writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');

const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(/^authors = \[.*\]$/m, `authors = [${JSON.stringify(name)}]`);
writeFileSync('src-tauri/Cargo.toml', cargo);

const amp = name.replace(/&/g, '&amp;');
for (const f of ['docs/index.html', 'docs/legal.html']) {
  const html = readFileSync(f, 'utf8').replace(/(<span data-nib-publisher>)[^<]*(<\/span>)/g, `$1${amp}$2`);
  writeFileSync(f, html);
}

console.log(`publisher ${old ?? '(none)'} -> ${name}`);
console.log('Also change it in Partner Center and in the GitHub variable MSIX_PUBLISHER_NAME (must match exactly).');
