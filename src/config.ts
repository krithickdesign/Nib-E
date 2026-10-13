// Links Nib-E shows. Set at build time (VITE_NIB_REPO, VITE_NIB_FORM in the
// build environment); on GitHub Pages the project page is worked out from the
// address. Nib-E never contacts these addresses itself: they open in the
// browser only when the person clicks.

import pkg from '../package.json';

export const APP_NAME = 'Nib-E';

/** Name Nib-E is published under (placeholder brand; change with `npm run publisher:set`). */
export const PUBLISHER: string = (pkg as { nibPublisher?: string }).nibPublisher ?? 'Nib-E contributors';

function guessRepo(): string {
  try {
    const host = location.hostname;
    if (/\.github\.io$/.test(host)) {
      const user = host.split('.')[0];
      const name = location.pathname.split('/').filter(Boolean)[0] || `${user}.github.io`;
      return `https://github.com/${user}/${name}`;
    }
  } catch {
    /* not in a browser page */
  }
  return '';
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Which build this is. "store" = Microsoft Store edition: the Store installs
 * updates, so Nib-E shows no link to download versions from elsewhere.
 */
export const EDITION: 'store' | 'standard' = env.VITE_NIB_EDITION === 'store' ? 'store' : 'standard';

/** How this build is named in Settings, About and feedback. */
export function buildLabel(desktop: boolean): string {
  if (!desktop) return 'web';
  return EDITION === 'store' ? 'Microsoft Store edition' : 'desktop app';
}

/** One sentence on how this build gets new versions (Nib-E itself never checks). */
export function updateNote(desktop: boolean): string {
  if (desktop && EDITION === 'store') return 'Updates are installed by the Microsoft Store, not by Nib-E. Nib-E itself stays offline.';
  if (desktop) return 'Nib-E never checks for updates by itself. Compare this number with the latest one on the website.';
  return 'The website always has the latest version. Nib-E never checks for updates by itself.';
}

/** The project page (source code, releases, issues). Empty when unknown. */
export const REPO_URL: string = (env.VITE_NIB_REPO ?? '').replace(/\/$/, '') || guessRepo();

/** Feedback and survey form (Google Form). Opens in the browser only when clicked. */
export const FORM_URL: string = env.VITE_NIB_FORM ?? 'https://docs.google.com/forms/d/e/1FAIpQLSfy3FUAR3hxknKPvrZi9NFxmflDDaBQQIV0PNaT5af3yO8xDA/viewform';

/**
 * The website's landing page for a given app address. On the website the app
 * lives in /app/, so the landing page is one folder up. Elsewhere (the single
 * Nib-E.html file, a page without a landing page) there is none: null.
 */
export function landingUrl(href: string): string | null {
  const home = env.VITE_NIB_HOME;
  if (home) return home;
  try {
    const dir = new URL('.', href);
    if (!/^https?:$/.test(dir.protocol)) return null;
    if (/\/app\/$/.test(dir.pathname)) return new URL('..', dir).href;
  } catch {
    /* not a URL */
  }
  return null;
}
