// Microsoft Store edition: asks once for a Store rating after real use.
// Shown at most once per week ("Later"), never again after "Rate" or
// "Don't ask again", never in the first session, and never while a dialog is
// open or something is being typed. Help → Rate Nib-E stays available.
import { EDITION } from '../config';
import { invoke, isDesktop } from '../platform/env';
import { store } from '../store';
import { toast } from './toast';

const KEY = 'nib.rate.v1';
const USE_BEFORE_ASK = 4 * 60_000; // minutes with a file open in this session
const LATER = 7 * 24 * 3600_000;

interface RateState {
  launches: number;
  done?: boolean;
  never?: boolean;
  nextAt?: number;
}

function read(): RateState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RateState | null;
    return v && typeof v.launches === 'number' ? v : { launches: 0 };
  } catch {
    return { launches: 0 };
  }
}

function write(s: RateState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the prompt simply won't remember */
  }
}

/** Opens the Store's rating page. Also used by Help → Rate Nib-E. */
export function openRating(): void {
  write({ ...read(), done: true });
  void invoke('open_review').catch(() => toast('Could not open the Microsoft Store.', 'error'));
}

export function startRatePrompt(): void {
  if (EDITION !== 'store' || !isDesktop()) return;
  const s = read();
  s.launches += 1;
  write(s);
  if (s.done || s.never || s.launches < 2) return;
  let used = 0;
  let last = Date.now();
  const timer = window.setInterval(() => {
    const now = Date.now();
    if (store.doc && document.visibilityState === 'visible') used += now - last;
    last = now;
    if (used < USE_BEFORE_ASK) return;
    const cur = read();
    if (cur.done || cur.never || (cur.nextAt && now < cur.nextAt)) {
      clearInterval(timer);
      return;
    }
    const modal = document.getElementById('modal') as HTMLDialogElement | null;
    if (modal?.open || store.editing || document.activeElement?.matches('input, textarea, select')) return;
    clearInterval(timer);
    void ask();
  }, 15_000);
}

async function ask(): Promise<void> {
  const { ask: dialog } = await import('./dialog');
  const res = await dialog({
    title: 'Enjoying Nib-E?',
    body: '<p>A rating in the Microsoft Store helps other people find a free PDF editor. It takes a few seconds.</p>',
    actions: [
      { label: "Don't ask again", value: 'never', kind: 'quiet' },
      { label: 'Later', value: 'later' },
      { label: 'Rate Nib-E', value: 'rate', kind: 'primary' },
    ],
  });
  const cur = read();
  if (res?.value === 'rate') openRating();
  else if (res?.value === 'never') write({ ...cur, never: true });
  else write({ ...cur, nextAt: Date.now() + LATER });
}
