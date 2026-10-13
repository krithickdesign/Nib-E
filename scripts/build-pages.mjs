// Copies the single-file app into docs/app/ for GitHub Pages.
// Run `npm run pages` (it builds first), then commit the docs/ folder.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('docs/app', { recursive: true });
copyFileSync('dist-single/index.html', 'docs/app/index.html');
console.log('docs/app/index.html updated');
