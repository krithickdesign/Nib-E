// Help menu (top right): tour, shortcuts, what's new, feedback, privacy, about.
// Feedback is never sent by Nib-E: it opens the project's issue form in the
// browser (filled in), or copies the text to paste anywhere.
import { APP_NAME, FORM_URL, REPO_URL } from '../config';
import { invoke, isDesktop } from '../platform/env';
import { VERSION } from '../version';
import { openHelp } from './help';
import { icon } from './icons';
import { toast } from './toast';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type HelpAction = 'tour' | 'keys' | 'new' | 'feedback' | 'survey' | 'privacy' | 'about';

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** A small modal built from HTML; resolves when closed. */
function modal(html: string, wire?: (dlg: HTMLDialogElement, close: () => void) => void): Promise<void> {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  dlg.innerHTML = `<div class="modal-form info-dialog">${html}<div class="dialog-actions"><span class="grow"></span><button class="btn btn-primary" type="button" data-x="close">Close</button></div></div>`;
  return new Promise((resolve) => {
    const close = () => {
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve();
    };
    dlg.querySelectorAll('[data-x="close"]').forEach((b) => b.addEventListener('click', close));
    dlg.onclose = close;
    wire?.(dlg, close);
    dlg.showModal();
  });
}

function shortcuts(): void {
  const row = (k: string, what: string) => `<tr><td>${k
    .split(' ')
    .map((x) => `<kbd>${esc(x)}</kbd>`)
    .join(' ')}</td><td>${what}</td></tr>`;
  void modal(`<h2>Keyboard shortcuts</h2>
    <table class="keys">
      ${row(`${mod} O`, 'Open a PDF')}
      ${row(`${mod} S`, 'Save')}
      ${row(`${mod} ⇧ S`, 'Save as')}
      ${row(`${mod} P`, 'Print')}
      ${row(`${mod} Z`, 'Undo')}
      ${row(`${mod} ⇧ Z`, 'Redo')}
      ${row(`${mod} + / −`, 'Zoom in / out')}
      ${row(`${mod} 0`, 'Fit to width')}
      ${row('F', 'Full page')}
      ${row('P', 'Pen')}
      ${row('M', 'Highlighter')}
      ${row('E', 'Eraser')}
      ${row('T', 'Text')}
      ${row('H', 'Hand (scroll, fill forms)')}
      ${row('V', 'Select')}
      ${row('S', 'Signature')}
      ${row('Del', 'Delete the selected mark')}
      ${row('?', 'Help tour')}
    </table>`);
}

function whatsNew(): void {
  void modal(`<h2>What's new in ${APP_NAME} ${esc(VERSION)}</h2>
    <ul class="help-points compact">
      <li>${icon('nib')}<span><strong>${APP_NAME}</strong>: Nib-E is now part of the Desk-E family.</span></li>
      <li>${icon('help')}<span><strong>Help menu</strong> with feedback, shortcuts and this list.</span></li>
      <li>${icon('settings')}<span><strong>Light / dark</strong> switch in Settings.</span></li>
      <li>${icon('open')}<span>Click the logo to open the ${isDesktop() ? 'start page in a new window' : 'Nib-E home page in a new tab'}.</span></li>
      <li>${icon('save')}<span>Save writes over the file you opened; Save menu with Export and Print; earlier version can be restored.</span></li>
      <li>${icon('book')}<span>Study notes are kept as you write and come back with the book.</span></li>
      <li>${icon('pen')}<span>Pen feel: Precise, Balanced, Smooth.</span></li>
      <li>${icon('network')}<span>Network: none. Desktop app for Windows, macOS and Linux.</span></li>
    </ul>`);
}

function about(): void {
  void modal(`<div class="about-head"><span class="brand-mark big">${icon('nib')}</span><div><h2>${APP_NAME}</h2><p class="muted mono">${esc(VERSION)} · ${isDesktop() ? 'desktop app' : 'web'}</p></div></div>
    <p>A private PDF reader and editor from the Desk-E line. Your files never leave this device.</p>
    <div class="net-row">${icon('network')}<span><strong>Network: none</strong><small>${isDesktop() ? 'The app has no permission to use the internet.' : 'This page is blocked from connecting anywhere once loaded.'} Nib-E never checks for updates by itself.</small></span></div>
    <p class="muted small">MIT licence. Built on PDFium (the PDF engine inside Chrome) via EmbedPDF, pdf-lib, perfect-freehand and fflate.${REPO_URL && !isDesktop() ? ` Source code: <a href="${esc(REPO_URL)}" target="_blank" rel="noopener noreferrer">${esc(REPO_URL.replace(/^https:\/\//, ''))}</a>` : ''}</p>`);
}

// ---------- feedback ----------

const KINDS = [
  { id: 'bug', icon: 'shieldAlert', title: 'Something broke', hint: 'An error, a wrong result, a crash', ask: 'What did you do, and what happened instead?', place: '1. Opened a form\n2. Typed into the name box\n3. The text appeared on the wrong line' },
  { id: 'confusing', icon: 'help', title: 'Something is confusing', hint: 'Hard to find, unclear words', ask: 'What were you trying to do, and where did you get stuck?', place: 'I wanted to … but I could not find …' },
  { id: 'idea', icon: 'wand', title: 'Idea or missing feature', hint: 'What would make Nib-E better for you', ask: 'What would you like Nib-E to do, and why?', place: 'When I study, I would like …' },
  { id: 'feedback', icon: 'comment', title: 'General opinion', hint: 'What you like, what you do not', ask: 'Tell us anything.', place: '' },
] as const;

function systemInfo(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? (navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS') : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  const screen = `${window.innerWidth}×${window.innerHeight}`;
  const touch = matchMedia('(pointer: coarse)').matches ? ', touch' : '';
  return `${APP_NAME} ${VERSION} (${isDesktop() ? 'desktop app' : 'web'}) · ${browser} on ${os} · window ${screen}${touch}`;
}

function feedback(): void {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  let kind: (typeof KINDS)[number] = KINDS[0];
  const canSend = !!FORM_URL;
  dlg.innerHTML = `
    <form class="modal-form feedback">
      <h2>Send feedback</h2>
      <div class="fb-step" data-step="1">
        <p class="dialog-sub">What is it about?</p>
        <div class="fb-kinds">${KINDS.map((k) => `<button type="button" class="fb-kind" data-kind="${k.id}">${icon(k.icon)}<span><strong>${k.title}</strong><small>${k.hint}</small></span></button>`).join('')}</div>
        ${canSend ? `<p class="muted small">Or <button type="button" class="link-btn inline" data-fb="survey">take the 5-minute survey</button> about how you use PDF tools.</p>` : ''}
      </div>
      <div class="fb-step" data-step="2" hidden>
        <label class="field-label" for="fb-text" id="fb-ask"></label>
        <textarea class="text-input fb-text" id="fb-text" rows="6"></textarea>
        <label class="check-row"><input type="checkbox" id="fb-sys" checked/><span><strong>Add technical details</strong><small id="fb-sys-text"></small></span></label>
        <p class="fb-privacy">${icon('lock')}<span>Nib-E sends nothing by itself. ${canSend ? 'The button copies your text and opens the feedback form in your browser: paste it into the last question (Ctrl+V). No account needed.' : ''} Or copy the text and send it any way you like. <strong>Never attach private documents</strong>: describe the problem or use a screenshot with personal details covered.</span></p>
        <div class="dialog-actions">
          <button class="btn btn-quiet" type="button" data-fb="back">Back</button>
          <span class="grow"></span>
          <button class="btn" type="button" data-fb="copy">${icon('copy')}Copy text</button>
          ${canSend ? `<button class="btn btn-primary" type="button" data-fb="send">${icon('open')}Copy and open the form</button>` : ''}
        </div>
      </div>
      <div class="dialog-actions fb-cancel"><span class="grow"></span><button class="btn btn-quiet" type="button" data-fb="cancel">Cancel</button></div>
    </form>`;
  const step = (n: 1 | 2) => {
    dlg.querySelectorAll<HTMLElement>('.fb-step').forEach((el) => (el.hidden = el.dataset.step !== String(n)));
    (dlg.querySelector('.fb-cancel') as HTMLElement).hidden = n === 2;
  };
  const text = dlg.querySelector('#fb-text') as HTMLTextAreaElement;
  (dlg.querySelector('#fb-sys-text') as HTMLElement).textContent = systemInfo();
  const compose = () => {
    const sys = (dlg.querySelector('#fb-sys') as HTMLInputElement).checked;
    const body = `**${kind.title}**\n\n${text.value.trim() || '(no description)'}${sys ? `\n\n---\n${systemInfo()}` : ''}`;
    const first = text.value.trim().split('\n')[0].slice(0, 70);
    const title = `${kind.title}: ${first || 'feedback'}`;
    return { title, body };
  };
  dlg.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const k = (t.closest('[data-kind]') as HTMLElement | null)?.dataset.kind;
    if (k) {
      kind = KINDS.find((x) => x.id === k) ?? KINDS[0];
      (dlg.querySelector('#fb-ask') as HTMLElement).textContent = kind.ask;
      text.placeholder = kind.place;
      step(2);
      text.focus();
      return;
    }
    const a = (t.closest('[data-fb]') as HTMLElement | null)?.dataset.fb;
    if (!a) return;
    if (a === 'back') step(1);
    if (a === 'cancel') dlg.close();
    if (a === 'copy') {
      const { title, body } = compose();
      try {
        await navigator.clipboard.writeText(`${title}\n\n${body}`);
        toast('Copied. Paste it into an email or message.', 'ok');
      } catch {
        text.select();
        toast('Select the text and copy it (Ctrl+C).', 'info');
      }
    }
    if (a === 'survey') {
      openForm();
      return;
    }
    if (a === 'send') {
      const { title, body } = compose();
      let copied = true;
      try {
        await navigator.clipboard.writeText(`${title}\n\n${body}`);
      } catch {
        copied = false;
      }
      openForm();
      dlg.close();
      toast(copied ? 'Copied. In the form, paste your text into the last question (Ctrl+V). Thank you!' : 'Form opened. Copy your text from Nib-E and paste it into the last question.', 'ok', 8000);
    }
  });
  dlg.showModal();
  (dlg.querySelector('.fb-kind') as HTMLElement).focus();
}

/** Opens the feedback / survey form in the person's browser. */
function openForm(): void {
  if (isDesktop()) void invoke('open_form').catch(() => toast('Could not open the browser.', 'error'));
  else window.open(FORM_URL, '_blank', 'noopener');
}

export function openFeedback(): void {
  feedback();
}

// ---------- menu ----------

export class HelpMenu {
  private isOpen = false;

  constructor(
    private anchor: HTMLElement,
    private menu: HTMLElement,
  ) {
    menu.setAttribute('role', 'menu');
    menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-help]') as HTMLElement | null;
      if (!b) return;
      this.close();
      this.run(b.dataset.help as HelpAction);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-help]')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        anchor.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    });
    window.addEventListener('resize', () => this.close());
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    const item = (a: HelpAction, ic: string, label: string, sub = '') =>
      `<button type="button" role="menuitem" class="menu-item" data-help="${a}">${icon(ic)}<span class="mi-text"><span class="mi-label">${label}</span>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
    this.menu.innerHTML =
      item('tour', 'help', 'Help and tour', 'How Nib-E works, in 9 short slides') +
      item('keys', 'edit', 'Keyboard shortcuts') +
      item('new', 'wand', "What's new", VERSION) +
      `<div class="menu-sep" role="separator"></div>` +
      item('feedback', 'comment', 'Send feedback', 'Report a problem or share an idea') +
      (FORM_URL ? item('survey', 'check', 'Take the survey', 'How you use PDF tools · 5 minutes') : '') +
      `<div class="menu-sep" role="separator"></div>` +
      item('privacy', 'lock', 'Privacy and safe mode') +
      item('about', 'info', `About ${APP_NAME}`);
    const ui = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
    const r = this.anchor.getBoundingClientRect();
    this.menu.hidden = false;
    this.menu.style.top = `${Math.round((r.bottom + 6) / ui)}px`;
    this.menu.style.right = `${Math.max(8, Math.round((window.innerWidth - r.right) / ui))}px`;
    this.isOpen = true;
    this.anchor.setAttribute('aria-expanded', 'true');
    (this.menu.querySelector('[data-help]') as HTMLElement | null)?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.anchor.setAttribute('aria-expanded', 'false');
  }

  private run(a: HelpAction): void {
    switch (a) {
      case 'tour':
        openHelp();
        break;
      case 'keys':
        shortcuts();
        break;
      case 'new':
        whatsNew();
        break;
      case 'feedback':
        feedback();
        break;
      case 'survey':
        openForm();
        break;
      case 'privacy':
        openHelp(1);
        break;
      case 'about':
        about();
        break;
    }
  }
}
