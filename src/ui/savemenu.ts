// The Save menu (arrow next to Save) and the Print dialog.
import { writtenNotes } from '../doc';
import { canWriteBack, hasSaveWindow, refLabel } from '../platform/files';
import { hasBackup, type PrintOptions } from '../saving';
import { store, type DocState } from '../store';
import { icon } from './icons';

export type MenuAction = 'save' | 'saveas' | 'with-notes' | 'flat' | 'notes-only' | 'images' | 'text' | 'backup' | 'print' | 'restore';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** What "Save" will do for this tab, in a few words. */
export function saveHint(doc: DocState | null): string {
  if (!doc) return '';
  if (doc.bookId && doc.keep === 'device') return 'Notes are kept on this device as you write';
  if (doc.file && canWriteBack(doc.file)) {
    const name = refLabel(doc.file).split(/[\\/]/).pop();
    return doc.bookId ? `Into “${name}”, with your notes` : `Over “${name}”`;
  }
  return hasSaveWindow() ? 'Choose where to save' : 'Downloads a copy';
}

export class SaveMenu {
  private isOpen = false;

  constructor(
    private anchor: HTMLElement,
    private menu: HTMLElement,
    private run: (a: MenuAction) => void,
  ) {
    menu.setAttribute('role', 'menu');
    menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-menu]') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      this.close();
      this.run(b.dataset.menu as MenuAction);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-menu]:not([disabled])')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        anchor.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    });
    window.addEventListener('resize', () => this.close());
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    const doc = store.doc;
    if (!doc) return;
    const backup = await hasBackup(doc);
    const notes = writtenNotes(doc) > 0;
    const item = (a: MenuAction, ic: string, label: string, sub = '', key = '', disabled = false) =>
      `<button type="button" role="menuitem" class="menu-item" data-menu="${a}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span class="mi-text"><span class="mi-label">${label}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
    this.menu.innerHTML =
      item('save', 'save', 'Save', saveHint(doc), `${mod}S`) +
      item('saveas', 'copy', 'Save as…', hasSaveWindow() ? 'A new file, anywhere you like' : 'Downloads a copy', `${mod}⇧S`) +
      `<div class="menu-sep" role="separator"></div><div class="menu-head">Export</div>` +
      (notes ? item('with-notes', 'study', 'PDF with my notes', 'Note pages added at the end') : '') +
      item('flat', 'flatten', 'Flattened PDF', 'Marks become part of the page') +
      (notes ? item('notes-only', 'lines', 'Only my notes') : '') +
      item('images', 'exportImg', 'Pages as images…', 'PNG or JPEG') +
      item('text', 'textFile', 'Text (.txt)') +
      (doc.bookId ? item('backup', 'backup', 'Notes backup (.nibe)', 'To move notes to another device') : '') +
      `<div class="menu-sep" role="separator"></div>` +
      item('print', 'print', 'Print…', '', `${mod}P`) +
      (backup ? item('restore', 'history', 'Restore earlier version', 'From before your last Save') : '') +
      (hasSaveWindow() ? '' : `<p class="menu-note">${icon('info')}This browser puts files in Downloads. For a Save window, use Chrome, Edge or the Nib-E desktop app, or turn on “Always ask where to save files” in your browser’s settings.</p>`);
    // The menu is drawn at the interface size; its position is given in that scale.
    const ui = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
    const r = this.anchor.getBoundingClientRect();
    this.menu.hidden = false;
    this.menu.style.top = `${Math.round((r.bottom + 6) / ui)}px`;
    this.menu.style.right = `${Math.max(8, Math.round((window.innerWidth - r.right) / ui))}px`;
    this.isOpen = true;
    this.anchor.setAttribute('aria-expanded', 'true');
    (this.menu.querySelector('[data-menu]') as HTMLElement | null)?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.anchor.setAttribute('aria-expanded', 'false');
  }
}

/** Print options. Resolves null when cancelled. */
export function askPrint(doc: DocState): Promise<PrintOptions | null> {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  const n = doc.plan.pages.length;
  const notes = writtenNotes(doc) > 0;
  const big = n > 60;
  dlg.innerHTML = `
    <form method="dialog" class="modal-form print-form">
      <h2>Print</h2>
      <div class="dialog-sub">
        <fieldset class="print-pages"><legend>Pages</legend>
          <label class="check-row"><input type="radio" name="pp" value="all" ${big ? '' : 'checked'}/><span>All ${n} pages${big ? ' <small>(large files take a while to prepare)</small>' : ''}</span></label>
          <label class="check-row"><input type="radio" name="pp" value="current" ${big ? 'checked' : ''}/><span>Current page (${doc.current + 1})</span></label>
          <label class="check-row"><input type="radio" name="pp" value="range"/><span>Pages</span><input class="text-input sm" id="pp-range" placeholder="e.g. 1-3, 5" autocomplete="off"/></label>
        </fieldset>
        <label class="check-row"><input type="checkbox" id="pp-marks" checked/><span><strong>Include my marks</strong><small>Writing, highlights, text, stamps and signatures.</small></span></label>
        ${notes ? `<label class="check-row"><input type="checkbox" id="pp-notes"/><span><strong>Add my note pages</strong><small>Printed after the document.</small></span></label>` : ''}
      </div>
      <div class="dialog-actions"><span class="grow"></span><button class="btn btn-quiet" type="button" data-x="cancel">Cancel</button><button class="btn btn-primary" type="submit">${icon('print')}Print…</button></div>
    </form>`;
  const range = dlg.querySelector('#pp-range') as HTMLInputElement;
  range.addEventListener('focus', () => ((dlg.querySelector('input[name="pp"][value="range"]') as HTMLInputElement).checked = true));
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: PrintOptions | null) => {
      if (done) return;
      done = true;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    (dlg.querySelector('[data-x="cancel"]') as HTMLElement).addEventListener('click', () => finish(null));
    (dlg.querySelector('form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      finish({
        which: ((dlg.querySelector('input[name="pp"]:checked') as HTMLInputElement | null)?.value ?? 'all') as PrintOptions['which'],
        range: range.value,
        marks: (dlg.querySelector('#pp-marks') as HTMLInputElement).checked,
        notes: !!(dlg.querySelector('#pp-notes') as HTMLInputElement | null)?.checked,
      });
    });
    dlg.onclose = () => finish(null);
    dlg.showModal();
    (dlg.querySelector('.btn-primary') as HTMLElement).focus();
  });
}
