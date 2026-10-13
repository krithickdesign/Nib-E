// Spelling check for everything typed in Nib. It is the browser's own checker:
// it runs on this device and never sends text anywhere (unless the person
// turned on "Enhanced spell check" in Chrome's settings, which is Google's).
import { store } from '../store';

/** Languages offered in Settings. '' follows the browser. */
export const SPELL_LANGS: [string, string][] = [
  ['', 'Same as the browser'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['nl', 'Nederlands'],
  ['pt', 'Português'],
  ['ta', 'தமிழ்'],
  ['hi', 'हिन्दी'],
];

/** Applies the spelling settings to a text field. */
export function spelling(el: HTMLTextAreaElement | HTMLInputElement): void {
  el.spellcheck = store.prefs.spellcheck;
  if (store.prefs.spellLang) el.lang = store.prefs.spellLang;
  else el.removeAttribute('lang');
}
