// "Help": a short slideshow about Nib. Opens by itself the first time.
import { icon } from './icons';

const SEEN_KEY = 'nib.help.v1';

interface Slide {
  icon: string;
  kicker: string;
  title: string;
  body: string;
  /** Small illustration in place of the big icon. */
  art?: string;
}

const kbd = (k: string) => `<kbd>${k}</kbd>`;

const SLIDES: Slide[] = [
  {
    icon: 'nib',
    kicker: 'Welcome',
    title: 'Nib is a private PDF reader and editor',
    body: `<p>Read, fill, sign, draw, comment, organise pages, redact and save. No account, nothing uploaded.</p>
      <p class="help-beta">This is a test version (beta). Some things will be rough. Your feedback shapes what comes next.</p>`,
  },
  {
    icon: 'lock',
    kicker: 'Privacy first',
    title: 'Your files never leave this device',
    body: `<ul class="help-points">
        <li>${icon('offline')}<span><strong>Nothing is uploaded.</strong> Opening, editing and saving all happen on your computer. Nib works with the internet switched off.</span></li>
        <li>${icon('eye')}<span><strong>No account, no tracking, no ads.</strong> Nib does not collect anything about you or your files.</span></li>
        <li>${icon('shield')}<span><strong>No AI.</strong> Nib never sends your text to an AI service. (A separate AI editor may come later, only if you switch it on.)</span></li>
        <li>${icon('network')}<span><strong>Network: none.</strong> The desktop app has no internet permission at all; the web version is blocked from connecting anywhere once loaded.</span></li>
      </ul>
      <p class="muted small">Nib keeps only your settings, a signature you chose to remember, stamps, study notes, unsaved-work copies and earlier versions of saved files, all on this device. Tools → Settings → Forget everything removes them.</p>`,
  },
  {
    icon: 'shield',
    kicker: 'Safe mode',
    title: 'Risky PDFs are opened safely',
    body: `<p>Scripts inside a PDF never run, links and attachments can't open anything by themselves. The green <strong>Safe mode</strong> chip at the top shows what Nib found and blocked in a file.</p>`,
  },
  {
    icon: 'open',
    kicker: 'Files and tabs',
    title: 'Open several PDFs at once',
    body: `<ul class="help-points">
        <li>${icon('open')}<span><strong>Open</strong> or drop a PDF on the window. Each file gets its own tab.</span></li>
        <li>${icon('rename')}<span><strong>Rename:</strong> double-click the file name at the top.</span></li>
        <li>${icon('save')}<span><strong>Save</strong> writes over the file you opened (desktop app, Chrome, Edge). The arrow next to Save has <strong>Save as</strong>, <strong>Export</strong> and <strong>Print</strong>, and can restore the version from before your last save.</span></li>
        <li>${icon('close')}<span>Closing a tab with changes asks whether to save first. If Nib closes unexpectedly, it offers your unsaved work the next time.</span></li>
        <li>${icon('addfile')}<span><strong>Add PDF</strong> puts another file's pages at the end of this one.</span></li>
      </ul>`,
  },
  {
    icon: 'fillSign',
    kicker: 'Forms',
    title: 'Fill forms, even ones without form fields',
    body: `<p>Nib looks for empty boxes, lines and tick boxes. When it finds some, a card on the right asks if you want to <strong>make them fillable</strong>. Then click a box and type: text takes the size and font of the question. ${kbd('Tab')} jumps to the next box.</p>
      <p>Sign with <strong>Fill &amp; Sign → Add signature</strong>. Draw it once and Nib can remember it on this device.</p>`,
  },
  {
    icon: 'pen',
    kicker: 'Draw and comment',
    title: 'Write on any page like on paper',
    body: `<p>The bar at the bottom has the pen, highlighter, text and eraser. A stylus uses pen pressure. <strong>Pen feel</strong> (next to the pen sizes) sets how much writing is smoothed: <em>Precise</em> for handwriting, <em>Smooth</em> for diagrams.</p>
      <p>The <strong>Tools</strong> button (top right) opens every tool: comments, shapes, stamps (design your own or use a PNG), images, header and footer, watermark, pages, compress, password, export.</p>`,
  },
  {
    icon: 'study',
    kicker: 'Study mode',
    title: 'Your PDF on the left, a notebook on the right',
    art: `<div class="help-study"><div class="hs-pdf"><i></i><i></i><i class="short"></i><b></b><i></i><i class="short"></i></div><div class="hs-nb"><svg viewBox="0 0 120 80" aria-hidden="true"><path d="M10 22c10-8 16 6 26-2s14 4 22-1M10 44c12-6 20 4 34-2M10 64c8-3 16 2 24-1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div></div>`,
    body: `<ul class="help-points">
        <li>${icon('study')}<span>Click <strong>Study</strong> at the top. Read the PDF on one side and write notes on the other; drag the middle bar to resize.</span></li>
        <li>${icon('lines')}<span>Note pages start <strong>lined</strong>. Switch a page to <strong>grid</strong> or <strong>blank</strong> in the notebook bar. <strong>+ Page</strong> adds one.</span></li>
        <li>${icon('pen')}<span>Draw with the pen on either side, e.g. highlight in the PDF and work out the answer in your notes.</span></li>
        <li>${icon('book')}<span>Notes are <strong>kept automatically</strong> on this device and the book file stays untouched. Open the same book later and you are back at your page with all notes. Prefer them inside the file? Tools → Study mode → <em>Write notes into the book</em>.</span></li>
      </ul>`,
  },
  {
    icon: 'redact',
    kicker: 'Redact',
    title: 'Remove private details for good',
    body: `<p><strong>Tools → Redact</strong>: drag over text or pictures, or search for a name and mark every match. Applying removes the text and erases the picture pixels under the boxes, then Nib checks that nothing is left.</p>`,
  },
  {
    icon: 'settings',
    kicker: 'Good to know',
    title: 'Tips',
    body: `<ul class="help-points compact">
        <li>${icon('settings')}<span><strong>Text too small or too big?</strong> Tools → Settings → Interface size.</span></li>
        <li>${icon('text')}<span><strong>Spelling:</strong> words you type are checked. Right-click a word underlined in red for suggestions.</span></li>
        <li>${icon('undo')}<span>${kbd('Ctrl')} ${kbd('Z')} undo · ${kbd('Ctrl')} ${kbd('S')} save · ${kbd('Ctrl')} ${kbd('P')} print · ${kbd('F')} full page · ${kbd('P')} pen · ${kbd('T')} text · ${kbd('H')} hand</span></li>
        <li>${icon('help')}<span>This tour is always under <strong>Help</strong> at the top.</span></li>
      </ul>`,
  },
];

export function helpSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Opens the tour at a slide (0 = welcome). */
export function openHelp(start = 0): void {
  document.getElementById('help-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog help';
  dlg.id = 'help-dialog';
  dlg.setAttribute('aria-label', 'Help');
  document.getElementById('app')!.append(dlg);
  let at = Math.max(0, Math.min(SLIDES.length - 1, start));

  const render = () => {
    const s = SLIDES[at];
    const last = at === SLIDES.length - 1;
    dlg.innerHTML = `
      <button class="icon-btn help-close" type="button" data-a="close" aria-label="Close help">${icon('close')}</button>
      <div class="help-slide" aria-live="polite">
        <div class="help-art">${s.art ?? `<span class="help-icon">${icon(s.icon)}</span>`}</div>
        <p class="help-kicker">${s.kicker} <span class="mono">${at + 1}/${SLIDES.length}</span></p>
        <h2>${s.title}</h2>
        <div class="help-body">${s.body}</div>
      </div>
      <div class="help-foot">
        <div class="help-dots" role="tablist" aria-label="Slides">${SLIDES.map((x, i) => `<button type="button" role="tab" class="help-dot" data-go="${i}" aria-selected="${i === at}" aria-label="${x.kicker}"></button>`).join('')}</div>
        <span class="grow"></span>
        ${at > 0 ? `<button class="btn btn-quiet" type="button" data-a="prev">Back</button>` : `<button class="btn btn-quiet" type="button" data-a="close">Skip</button>`}
        <button class="btn btn-primary" type="button" data-a="${last ? 'close' : 'next'}">${last ? 'Start using Nib' : 'Next'}</button>
      </div>`;
    if (dlg.open) (dlg.querySelector('.help-foot .btn-primary') as HTMLElement | null)?.focus();
  };

  const close = () => {
    markSeen();
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) {
      // A click on the backdrop closes the tour.
      if (e.target === dlg) {
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      }
      return;
    }
    if (b.dataset.go) at = Number(b.dataset.go);
    else if (b.dataset.a === 'next') at = Math.min(SLIDES.length - 1, at + 1);
    else if (b.dataset.a === 'prev') at = Math.max(0, at - 1);
    else if (b.dataset.a === 'close') return close();
    render();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && at < SLIDES.length - 1) {
      at++;
      render();
    } else if (e.key === 'ArrowLeft' && at > 0) {
      at--;
      render();
    }
    e.stopPropagation();
  });
  dlg.addEventListener('close', () => {
    markSeen();
    dlg.remove();
  });
  render();
  dlg.showModal();
  (dlg.querySelector('.help-foot .btn-primary') as HTMLElement | null)?.focus();
}
