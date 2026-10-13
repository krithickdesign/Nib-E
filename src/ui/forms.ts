// Fillable form fields. PDFium draws the fields and their values; this layer
// adds clickable hotspots on top and writes changes back through the engine.
import { isWidgetChecked, PDF_FORM_FIELD_TYPE, type PdfWidgetAnnoObject } from '@embedpdf/models';
import { toScreen, type PageEntry } from '../model';
import { engine } from '../pdf/pdfium';
import { store } from '../store';
import { bumpFormRevision } from './render';
import { spelling } from './spelling';

const READ_ONLY = 1;
const SUPPORTED = new Set([PDF_FORM_FIELD_TYPE.TEXTFIELD, PDF_FORM_FIELD_TYPE.CHECKBOX, PDF_FORM_FIELD_TYPE.RADIOBUTTON, PDF_FORM_FIELD_TYPE.COMBOBOX, PDF_FORM_FIELD_TYPE.LISTBOX]);

export class FormLayer {
  private el: HTMLDivElement;
  private widgets: PdfWidgetAnnoObject[] | null = null;
  private loading = false;
  private editing = false;

  constructor(
    paper: HTMLElement,
    private entry: () => PageEntry,
    private k: () => number,
    private changed: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'layer-forms';
    paper.append(this.el);
    this.setActive(store.tool === 'hand');
  }

  private target() {
    const e = this.entry();
    const src = e.src ? store.doc?.sources.get(e.src) : undefined;
    return src ? { doc: src.doc, page: src.doc.pages[e.index] } : null;
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
      const list = await engine().getPageAnnoWidgets(t.doc, t.page).toPromise();
      this.widgets = list.filter((w) => SUPPORTED.has(w.field.type) && !(w.field.flag & READ_ONLY));
    } catch {
      this.widgets = [];
    } finally {
      this.loading = false;
    }
    this.layout();
  }

  setActive(on: boolean): void {
    this.el.classList.toggle('active', on);
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

  layout(): void {
    if (!this.widgets || this.editing) return;
    this.el.textContent = '';
    this.widgets.forEach((w) => {
      const b = this.box(w);
      const type = w.field.type;
      let node: HTMLElement;
      if (type === PDF_FORM_FIELD_TYPE.COMBOBOX || type === PDF_FORM_FIELD_TYPE.LISTBOX) {
        const sel = document.createElement('select');
        sel.className = 'field field-choice';
        const opts = 'options' in w.field ? w.field.options : [];
        sel.append(new Option('', '', true, !opts.some((o) => o.isSelected)));
        opts.forEach((o, i) => sel.append(new Option(o.label, String(i), false, o.isSelected)));
        sel.addEventListener('change', () => {
          if (sel.value !== '') void this.apply(w, { kind: 'selection', index: Number(sel.value), isSelected: true });
        });
        node = sel;
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        const toggle = type !== PDF_FORM_FIELD_TYPE.TEXTFIELD;
        btn.className = `field ${toggle ? 'field-toggle' : 'field-text'}`;
        btn.setAttribute('aria-label', w.field.alternateName || w.field.name || 'Form field');
        if (toggle) {
          const on = isWidgetChecked(w);
          btn.setAttribute('aria-pressed', String(on));
          btn.addEventListener('click', () => void this.apply(w, { kind: 'checked', checked: type === PDF_FORM_FIELD_TYPE.RADIOBUTTON ? true : !on }));
        } else {
          btn.addEventListener('click', () => this.editText(w, btn));
        }
        node = btn;
      }
      node.title = w.field.alternateName || w.field.name;
      Object.assign(node.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
      this.el.append(node);
    });
  }

  private editText(w: PdfWidgetAnnoObject, anchor: HTMLElement): void {
    const b = this.box(w);
    const input = document.createElement('input');
    input.className = 'field-input';
    spelling(input);
    input.value = w.field.value ?? '';
    const max = 'maxLen' in w.field ? w.field.maxLen : undefined;
    if (max) input.maxLength = max;
    const size = (w.fontSize > 0 ? w.fontSize : Math.min(12, (w.rect.size.height * 0.62))) * this.k();
    Object.assign(input.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, fontSize: `${Math.max(10, size)}px` });
    anchor.replaceWith(input);
    this.editing = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      if (commit && input.value !== (w.field.value ?? '')) void this.apply(w, { kind: 'text', text: input.value });
      else this.layout();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  private async apply(w: PdfWidgetAnnoObject, value: Parameters<ReturnType<typeof engine>['setFormFieldValue']>[3]): Promise<void> {
    const t = this.target();
    if (!t) return;
    try {
      await engine().setFormFieldValue(t.doc, t.page, w, value).toPromise();
    } catch (e) {
      console.error('form update failed', e);
    }
    bumpFormRevision(this.entry().src!);
    store.dirty = true;
    store.emit('dirty');
    this.widgets = null;
    this.changed();
    await this.load();
  }
}
