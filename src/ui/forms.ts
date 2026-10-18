// Real form fields (AcroForm). PDFium draws the fields and their values; this
// layer puts clickable controls on top and writes changes back through the engine.
//
// Fields react to the Hand, Select, Text and Checkmark tools, so typing on a
// form always fills the field instead of placing loose text over it. With the
// drawing tools the layer lets clicks through (you can still write on a form).
// Every field gets a faint tint so a form is recognisable at a glance.
import { isWidgetChecked, PDF_FORM_FIELD_TYPE, type PdfWidgetAnnoObject } from '@embedpdf/models';
import { toScreen, type PageEntry } from '../model';
import { pressButton, resetButtons } from '../pdf/formactions';
import { engine } from '../pdf/pdfium';
import { store, type Tool } from '../store';
import { bumpFormRevision } from './render';
import { spelling } from './spelling';

const FLAG = {
  READ_ONLY: 1,
  MULTILINE: 1 << 12,
  PASSWORD: 1 << 13,
  MULTI_SELECT: 1 << 21,
  COMB: 1 << 24,
};
const T = PDF_FORM_FIELD_TYPE;
const SUPPORTED = new Set([T.TEXTFIELD, T.CHECKBOX, T.RADIOBUTTON, T.COMBOBOX, T.LISTBOX, T.PUSHBUTTON]);
/** Tools with which a click on a field fills it. */
export const FIELD_TOOLS = new Set<Tool>(['hand', 'select', 'text', 'mark']);

type Value = Parameters<ReturnType<typeof engine>['setFormFieldValue']>[3];

export class FormLayer {
  private el: HTMLDivElement;
  private widgets: PdfWidgetAnnoObject[] | null = null;
  private loading = false;
  private editing = false;
  private active = false;
  /** Text field to open next (Tab), by its order among the page's text fields. */
  private pendingFocus: number | null = null;

  constructor(
    paper: HTMLElement,
    private entry: () => PageEntry,
    private k: () => number,
    private changed: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'layer-forms';
    paper.append(this.el);
    this.setActive(FIELD_TOOLS.has(store.tool));
  }

  private target() {
    const e = this.entry();
    const src = e.src ? store.doc?.sources.get(e.src) : undefined;
    return src ? { src, doc: src.doc, page: src.doc.pages[e.index] } : null;
  }

  /** True when the page has at least one fillable field. */
  hasFields(): boolean {
    return !!this.widgets?.length;
  }

  show(): void {
    if (this.widgets === null) void this.load();
    else if (!this.editing) this.layout();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    const t = this.target();
    if (!t) return;
    this.loading = true;
    try {
      const [list, resets] = await Promise.all([engine().getPageAnnoWidgets(t.doc, t.page).toPromise(), resetButtons(t.src.bytes)]);
      this.widgets = list.filter((w) => SUPPORTED.has(w.field.type) && !(w.field.flag & FLAG.READ_ONLY) && (w.field.type !== T.PUSHBUTTON || resets.has(w.field.name)));
    } catch {
      this.widgets = [];
    } finally {
      this.loading = false;
    }
    this.layout();
  }

  setActive(on: boolean): void {
    this.active = on;
    this.el.classList.toggle('active', on);
    if (!this.editing && this.widgets) this.layout();
  }

  destroy(): void {
    this.el.remove();
  }

  private box(w: PdfWidgetAnnoObject) {
    const e = this.entry();
    const k = this.k();
    const { x, y } = w.rect.origin;
    const { width, height } = w.rect.size;
    const [ax, ay] = toScreen(e, x, y);
    const [bx, by] = toScreen(e, x + width, y + height);
    return { left: Math.min(ax, bx) * k, top: Math.min(ay, by) * k, width: Math.abs(bx - ax) * k, height: Math.abs(by - ay) * k };
  }

  /** Font size in screen pixels for typing into a field. */
  private fontPx(w: PdfWidgetAnnoObject, multiline: boolean): number {
    const h = Math.min(w.rect.size.height, w.rect.size.width);
    const pt = w.fontSize > 0 ? w.fontSize : multiline ? 12 : Math.min(12, h * 0.62);
    return Math.max(9, pt * this.k());
  }

  private place(node: HTMLElement, w: PdfWidgetAnnoObject): void {
    const b = this.box(w);
    Object.assign(node.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  }

  layout(): void {
    if (!this.widgets || this.editing) return;
    this.el.textContent = '';
    for (const w of this.widgets) {
      const type = w.field.type;
      const label = w.field.alternateName || w.field.name || 'Form field';
      let node: HTMLElement;
      if (type === T.COMBOBOX) node = this.combo(w);
      else if (type === T.LISTBOX) node = this.list(w);
      else if (type === T.PUSHBUTTON) {
        node = this.button('field field-push', label);
        node.addEventListener('click', () => void this.reset(w));
        node.title = 'Reset the form';
      } else if (type === T.TEXTFIELD) {
        node = this.button(`field field-text${w.field.flag & FLAG.COMB ? ' field-comb' : ''}`, label);
        node.addEventListener('click', () => this.editText(w, node));
      } else {
        const on = isWidgetChecked(w);
        node = this.button('field field-toggle', label);
        node.setAttribute('aria-pressed', String(on));
        node.addEventListener('click', () => void this.apply(w, { kind: 'checked', checked: type === T.RADIOBUTTON ? true : !on }));
      }
      if (!node.title) node.title = label;
      this.place(node, w);
      this.el.append(node);
    }
    if (this.pendingFocus !== null) {
      const i = this.pendingFocus;
      this.pendingFocus = null;
      (this.el.querySelectorAll<HTMLElement>('.field-text')[i] as HTMLElement | undefined)?.click();
    }
  }

  private button(cls: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.setAttribute('aria-label', label);
    btn.tabIndex = this.active ? 0 : -1;
    return btn;
  }

  /** Dropdown: the native list opens on click; a visible ▼ shows it is one. */
  private combo(w: PdfWidgetAnnoObject): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'field field-combo';
    const sel = document.createElement('select');
    sel.className = 'field-choice';
    sel.tabIndex = this.active ? 0 : -1;
    sel.setAttribute('aria-label', w.field.alternateName || w.field.name || 'Choice');
    const opts = 'options' in w.field ? w.field.options : [];
    sel.append(new Option('', '', true, !opts.some((o) => o.isSelected)));
    opts.forEach((o, i) => sel.append(new Option(o.label, String(i), false, o.isSelected)));
    sel.addEventListener('change', () => {
      if (sel.value !== '') void this.apply(w, { kind: 'selection', index: Number(sel.value), isSelected: true });
    });
    const chip = document.createElement('span');
    chip.className = 'field-chip';
    chip.setAttribute('aria-hidden', 'true');
    chip.style.width = `${Math.min(this.box(w).height, 22)}px`;
    wrap.append(sel, chip);
    return wrap;
  }

  /** List box: its rows, clickable (several with Ctrl when the field allows it). */
  private list(w: PdfWidgetAnnoObject): HTMLElement {
    const box = document.createElement('div');
    box.className = 'field field-list';
    box.setAttribute('role', 'listbox');
    const multi = !!(w.field.flag & FLAG.MULTI_SELECT);
    if (multi) box.setAttribute('aria-multiselectable', 'true');
    box.setAttribute('aria-label', w.field.alternateName || w.field.name || 'List');
    const opts = 'options' in w.field ? w.field.options : [];
    const px = this.fontPx(w, true);
    box.style.fontSize = `${px}px`;
    opts.forEach((o, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'field-row';
      row.tabIndex = this.active ? 0 : -1;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(o.isSelected));
      row.textContent = o.label;
      row.style.height = `${px * 1.17}px`;
      row.addEventListener('click', (ev) => {
        if (multi) {
          // Plain click toggles in lists that allow several choices; that is
          // easier with a pen or a finger than holding Ctrl.
          void this.apply(w, { kind: 'selection', index: i, isSelected: !o.isSelected });
        } else void this.apply(w, { kind: 'selection', index: i, isSelected: true });
        ev.stopPropagation();
      });
      box.append(row);
    });
    if (multi) box.title = `${w.field.alternateName || w.field.name}: click to choose one or more`;
    return box;
  }

  private editText(w: PdfWidgetAnnoObject, anchor: HTMLElement): void {
    const flag = w.field.flag;
    const multiline = !!(flag & FLAG.MULTILINE);
    const max = 'maxLen' in w.field ? w.field.maxLen : undefined;
    const comb = !!(flag & FLAG.COMB) && !!max && max > 0 && !multiline;
    const input: HTMLInputElement | HTMLTextAreaElement = multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = `field-input${comb ? ' field-input-comb' : ''}${multiline ? ' field-input-multi' : ''}`;
    if (input instanceof HTMLInputElement && flag & FLAG.PASSWORD) input.type = 'password';
    else spelling(input);
    input.value = w.field.value ?? '';
    if (max) input.maxLength = max;
    this.place(input, w);
    const b = this.box(w);
    const px = this.fontPx(w, multiline);
    input.style.fontSize = `${px}px`;
    if (comb) this.combStyle(input as HTMLInputElement, b.width, b.height, max!);
    anchor.replaceWith(input);
    this.editing = true;
    input.focus();
    if (comb) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      if (commit && input.value !== (w.field.value ?? '')) void this.apply(w, { kind: 'text', text: input.value });
      else this.layout();
    };
    input.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const texts = (this.widgets ?? []).filter((x) => x.field.type === T.TEXTFIELD);
        const next = texts.indexOf(w) + (e.shiftKey ? -1 : 1);
        if (next >= 0 && next < texts.length) this.pendingFocus = next;
        finish(true);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  /**
   * Comb fields (one character per box): a monospaced font, spaced so each
   * character sits in the middle of its box, and the boxes drawn behind.
   */
  private combStyle(input: HTMLInputElement, width: number, height: number, cells: number): void {
    const cell = width / cells;
    const family = "ui-monospace, 'Cascadia Mono', Consolas, Menlo, 'Courier New', monospace";
    const size = Math.max(9, Math.min(height * 0.62, cell * 1.25));
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${size}px ${family}`;
    const cw = ctx.measureText('0').width;
    const gap = Math.max(0, cell - cw);
    Object.assign(input.style, {
      fontFamily: family,
      fontSize: `${size}px`,
      letterSpacing: `${gap}px`,
      paddingLeft: `${gap / 2}px`,
      paddingRight: '0',
      backgroundImage: `repeating-linear-gradient(90deg, transparent 0 ${cell - 1}px, rgba(47, 63, 214, 0.35) ${cell - 1}px ${cell}px)`,
    });
  }

  /** Reset button: clears the form, as the button's own (standard, script-free) action does. */
  private async reset(w: PdfWidgetAnnoObject): Promise<void> {
    const t = this.target();
    if (!t) return;
    const { ask } = await import('./dialog');
    const r = await ask({
      title: 'Reset the form?',
      body: '<p>All answers in this form are cleared. Undo cannot bring them back.</p>',
      actions: [
        { label: 'Cancel', value: false, kind: 'quiet' },
        { label: 'Reset', value: true, kind: 'primary' },
      ],
    });
    if (!r?.value) return;
    try {
      pressButton(t.doc, t.page.index, w.id);
    } catch (e) {
      console.error('form reset failed', e);
    }
    this.afterChange();
  }

  private async apply(w: PdfWidgetAnnoObject, value: Value): Promise<void> {
    const t = this.target();
    if (!t) return;
    try {
      await engine().setFormFieldValue(t.doc, t.page, w, value).toPromise();
    } catch (e) {
      console.error('form update failed', e);
    }
    this.afterChange();
  }

  private afterChange(): void {
    const src = this.entry().src;
    if (src) bumpFormRevision(src);
    store.dirty = true;
    store.emit('dirty');
    // Other pages may show the same field (or a reset changed them all).
    store.emit('formvalues');
    this.widgets = null;
    this.changed();
    void this.load();
  }

  /** Reloads the values (after another page changed a shared field). */
  refresh(): void {
    if (this.editing) return;
    this.widgets = null;
    void this.load();
  }
}
