// Links Nib-E shows. Set at build time (VITE_NIB_REPO, VITE_NIB_FORM in the
// build environment); on GitHub Pages the project page is worked out from the
// address. Nib-E never contacts these addresses itself: they open in the
// browser only when the person clicks.

export const APP_NAME = 'Nib-E';

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

/** The project page (source code, releases, issues). Empty when unknown. */
export const REPO_URL: string = (env.VITE_NIB_REPO ?? '').replace(/\/$/, '') || guessRepo();

/** Feedback and survey form (Google Form). Opens in the browser only when clicked. */
export const FORM_URL: string = env.VITE_NIB_FORM ?? 'https://docs.google.com/forms/d/e/1FAIpQLSfy3FUAR3hxknKPvrZi9NFxmflDDaBQQIV0PNaT5af3yO8xDA/viewform';
