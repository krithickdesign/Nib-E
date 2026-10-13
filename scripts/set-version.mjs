// Sets the version everywhere it is written down.
//   node scripts/set-version.mjs 0.5.1
// package.json is the source; Cargo.toml (Rust) and package-lock.json follow.
// The desktop app (tauri.conf.json) and the web app read package.json directly.
import { readFileSync, writeFileSync } from 'node:fs';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) {
  console.error('Give a version like 0.5.1 (three numbers; Windows installers need plain numbers).');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const old = pkg.version;
pkg.version = v;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = v;
if (lock.packages?.['']) lock.packages[''].version = v;
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(/^version = "[^"]*"/m, `version = "${v}"`);
writeFileSync('src-tauri/Cargo.toml', cargo);
const lockToml = readFileSync('src-tauri/Cargo.lock', 'utf8').replace(/(\[\[package\]\]\nname = "nib"\nversion = )"[^"]*"/, `$1"${v}"`);
writeFileSync('src-tauri/Cargo.lock', lockToml);

// The website footer shows the version too.
const site = readFileSync('docs/index.html', 'utf8').replace(/Nib-E \d+\.\d+\.\d+ beta/, `Nib-E ${v} beta`);
writeFileSync('docs/index.html', site);

console.log(`version ${old} -> ${v}`);
