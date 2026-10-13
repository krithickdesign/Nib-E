// A small modal dialog for confirmations and short questions.
export interface DialogAction<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger' | 'quiet';
}

export interface DialogOptions<T> {
  title: string;
  body?: string;
  /** Show a text input; its value is passed to `read`. */
  input?: { label: string; value?: string; placeholder?: string; type?: string };
  actions: DialogAction<T>[];
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface DialogResult<T> {
  value: T;
  text: string;
  /** Checkboxes in the body, by id. */
  checks: Record<string, boolean>;
}

export function ask<T>(opts: DialogOptions<T>): Promise<DialogResult<T> | null> {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  dlg.innerHTML = `
    <form method="dialog" class="modal-form">
      <h2>${esc(opts.title)}</h2>
      ${opts.body ? `<div class="dialog-sub">${opts.body}</div>` : ''}
      ${opts.input ? `<label class="field-label">${esc(opts.input.label)}<input class="text-input" id="modal-input" type="${opts.input.type ?? 'text'}" value="${esc(opts.input.value ?? '')}" placeholder="${esc(opts.input.placeholder ?? '')}" autocomplete="off" /></label>` : ''}
      <div class="dialog-actions"><span class="grow"></span>${opts.actions
        .map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'quiet' ? 'btn-quiet' : ''}" type="${a.kind === 'primary' || a.kind === 'danger' ? 'submit' : 'button'}" data-i="${i}">${esc(a.label)}</button>`)
        .join('')}</div>
    </form>`;
  const input = dlg.querySelector('#modal-input') as HTMLInputElement | null;
  return new Promise((resolve) => {
    let done = false;
    const checks = () => Object.fromEntries([...dlg.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id]')].map((c) => [c.id, c.checked]));
    const finish = (r: DialogResult<T> | null) => {
      if (done) return;
      done = true;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(r);
    };
    dlg.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        finish({ value: opts.actions[Number(b.dataset.i)].value, text: input?.value ?? '', checks: checks() });
      }),
    );
    (dlg.querySelector('form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      const primary = opts.actions.find((a) => a.kind === 'primary' || a.kind === 'danger');
      if (primary) finish({ value: primary.value, text: input?.value ?? '', checks: checks() });
    });
    dlg.onclose = () => finish(null);
    dlg.showModal();
    (input ?? (dlg.querySelector('.btn-primary, .btn-danger') as HTMLElement | null))?.focus();
    input?.select();
  });
}
