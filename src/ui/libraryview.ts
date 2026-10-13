// "Continue studying" list on the start screen.
import { backupJson, forgetBook, getBook, importBackup, listBooks, reopenBook, type BookRecord } from '../library';
import { saveFile } from '../platform/files';
import { store } from '../store';
import { ask } from './dialog';
import { icon } from './icons';
import { toast } from './toast';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function ago(t: number): string {
  const d = (Date.now() - t) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}

export class LibraryView {
  constructor(
    private el: HTMLElement,
    private openPicker: () => void,
    private busy: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>,
  ) {
    el.addEventListener('click', (e) => void this.onClick(e));
    store.on((why) => {
      if (why === 'library' || why === 'tabs' || why === 'doc') void this.render();
    });
    void this.render();
  }

  async render(): Promise<void> {
    if (store.doc) {
      this.el.innerHTML = '';
      return;
    }
    const books = await listBooks();
    if (!books.length) {
      this.el.innerHTML = `<button class="link-btn" type="button" data-lib="import">${icon('backup')}Restore notes from a backup (.nibe)</button>`;
      return;
    }
    this.el.innerHTML = `
      <h3>${icon('book')}Continue studying</h3>
      <ul class="lib-list">${books
        .slice(0, 8)
        .map((b) => this.row(b))
        .join('')}</ul>
      <button class="link-btn" type="button" data-lib="import">${icon('backup')}Restore notes from a backup (.nibe)</button>`;
  }

  private row(b: BookRecord): string {
    const pct = b.pages ? Math.round(((b.current + 1) / b.pages) * 100) : 0;
    const where = b.keep === 'file' ? 'Notes inside the file' : 'Notes on this device';
    return `<li class="lib-row">
      <button type="button" class="lib-open" data-lib="open" data-id="${b.id}" title="Open “${esc(b.name)}” at page ${b.current + 1}">
        <span class="lib-name">${esc(b.name.replace(/\.pdf$/i, ''))}</span>
        <span class="lib-meta">Page ${b.current + 1} of ${b.pages} · ${b.notePages} note page${b.notePages === 1 ? '' : 's'} · ${ago(b.updated)}</span>
        <span class="lib-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="lib-where">${where}</span>
      </button>
      <button type="button" class="icon-btn sm" data-lib="backup" data-id="${b.id}" title="Back up these notes (.nibe)" aria-label="Back up notes of ${esc(b.name)}">${icon('backup')}</button>
      <button type="button" class="icon-btn sm danger" data-lib="forget" data-id="${b.id}" title="Forget these notes" aria-label="Forget notes of ${esc(b.name)}">${icon('trash')}</button>
    </li>`;
  }

  private async onClick(e: Event): Promise<void> {
    const b = (e.target as HTMLElement).closest('[data-lib]') as HTMLElement | null;
    if (!b) return;
    const id = b.dataset.id ?? '';
    switch (b.dataset.lib) {
      case 'open': {
        const rec = await getBook(id);
        if (!rec) return;
        const ok = await this.busy('Opening…', () => reopenBook(rec));
        if (!ok) {
          toast(`Open “${rec.name}” again: Nib-E will find your notes and the page where you stopped.`, 'info', 7000);
          this.openPicker();
        }
        break;
      }
      case 'backup': {
        const out = await backupJson(id);
        if (out) await saveFile(out.name, out.bytes, 'application/json');
        break;
      }
      case 'forget': {
        const rec = await getBook(id);
        if (!rec) return;
        const r = await ask({
          title: `Forget the notes for “${rec.name}”?`,
          body: `<p>Removes ${rec.notePages} note page${rec.notePages === 1 ? '' : 's'} and your marks on this book from this device. The book file itself is not touched.${rec.keep === 'file' ? ' Notes already saved into the file stay there.' : ''}</p>`,
          actions: [
            { label: 'Cancel', value: false, kind: 'quiet' },
            { label: 'Forget', value: true, kind: 'danger' },
          ],
        });
        if (r?.value) await forgetBook(id);
        break;
      }
      case 'import': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.nibe,.nib,application/json';
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          try {
            const name = await importBackup(new Uint8Array(await f.arrayBuffer()));
            toast(`Notes for “${name}” restored. Open the book to see them.`, 'ok', 6000);
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        };
        input.click();
        break;
      }
    }
  }
}
