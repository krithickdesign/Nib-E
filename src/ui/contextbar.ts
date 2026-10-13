// The bar that appears above the page: font controls while adding or editing
// text, and quick actions for any selected item.
import { unsupportedChars } from '../pdf/core';
import { uid, type FontFamily, type Item, type TextItem } from '../model';
import { store } from '../store';
import { FONT_LABEL } from './draw';
import { icon } from './icons';
import { COLOR_NAMES, MARKUP_COLORS, NOTE_COLORS, SHAPE_COLORS, TEXT_COLORS } from './tools';
import { applyTextStyle, editingText } from './viewer';

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

export class ContextBar {
  constructor(private root: HTMLElement, private onDelete: () => void) {
    // Keep focus in the text box while using the bar.
    root.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('select, input')) e.preventDefault();
    });
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('change', (e) => this.onChange(e));
    store.on((why) => {
      if (why === 'tool' || why === 'selection' || why === 'editing' || why === 'items' || why === 'prefs') this.render();
    });
    this.render();
  }

  /** The text style shown: the box being edited, else the selected text, else the defaults. */
  private target(): { text: TextItem | null; item: Item | null } {
    const ed = editingText();
    if (ed) return { text: ed, item: ed };
    const sel = store.sel;
    const it = sel ? store.findItem(sel.key, sel.id) : null;
    return { text: it?.type === 'text' ? it : null, item: it };
  }

  render(): void {
    const { text, item } = this.target();
    const showText = !!text || store.tool === 'text';
    if (!showText && !item) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    if (showText) {
      const p = store.prefs;
      const font: FontFamily = text?.font ?? p.textFont;
      const size = text?.size ?? p.textSize;
      const bold = text?.bold ?? p.textBold;
      const italic = text?.italic ?? p.textItalic;
      const color = text?.color ?? p.textColor;
      const bad = text ? unsupportedChars(text.text) : [];
      const sizes = SIZES.includes(size) ? SIZES : [...SIZES, size].sort((a, b) => a - b);
      this.root.innerHTML = `
        <label class="ctx-field"><span class="sr">Font</span>
          <select id="ctx-font" aria-label="Font">${(['sans', 'serif', 'mono'] as FontFamily[]).map((f) => `<option value="${f}" ${f === font ? 'selected' : ''}>${FONT_LABEL[f]}</option>`).join('')}</select>
        </label>
        <div class="ctx-size">
          <button class="icon-btn sm" type="button" data-a="smaller" aria-label="Smaller">${icon('minus')}</button>
          <select id="ctx-size" aria-label="Font size">${sizes.map((s) => `<option value="${s}" ${s === size ? 'selected' : ''}>${s} pt</option>`).join('')}</select>
          <button class="icon-btn sm" type="button" data-a="bigger" aria-label="Bigger">${icon('plus')}</button>
        </div>
        <span class="ctx-sep"></span>
        <button class="icon-btn sm" type="button" data-a="bold" aria-pressed="${bold}" aria-label="Bold" title="Bold">${icon('bold')}</button>
        <button class="icon-btn sm" type="button" data-a="italic" aria-pressed="${italic}" aria-label="Italic" title="Italic">${icon('italic')}</button>
        <span class="ctx-sep"></span>
        ${TEXT_COLORS.map((c) => `<button class="swatch sm" type="button" data-color="${c}" style="--sw:${c}" aria-label="${COLOR_NAMES[c]}" aria-pressed="${c === color}"></button>`).join('')}
        ${item ? `<span class="ctx-sep"></span><button class="icon-btn sm danger" type="button" data-a="delete" aria-label="Delete" title="Delete">${icon('trash')}</button>` : ''}
        ${bad.length ? `<span class="ctx-warn" title="Standard PDF fonts cannot store these characters. They will be saved as ?">Can't save: ${bad.join(' ')}</span>` : ''}
        ${text?.field ? `<span class="ctx-hint">Tab: next box</span>` : ''}`;
      return;
    }
    // Non-text selection.
    let colors: string[] = [];
    let current = '';
    if (item?.type === 'shape') [colors, current] = [SHAPE_COLORS, item.color];
    else if (item?.type === 'note') [colors, current] = [NOTE_COLORS, item.color];
    else if (item?.type === 'markup') [colors, current] = [MARKUP_COLORS, item.color];
    else if (item?.type === 'mark' || item?.type === 'ink') [colors, current] = [TEXT_COLORS, item.color];
    const label = item ? ITEM_LABELS[item.type] : '';
    this.root.innerHTML = `
      <span class="ctx-label">${label}</span>
      ${colors.length ? `<span class="ctx-sep"></span>${colors.map((c) => `<button class="swatch sm" type="button" data-color="${c}" style="--sw:${c}" aria-label="${COLOR_NAMES[c] ?? c}" aria-pressed="${c === current}"></button>`).join('')}` : ''}
      <span class="ctx-sep"></span>
      <button class="icon-btn sm" type="button" data-a="duplicate" aria-label="Duplicate" title="Duplicate">${icon('copy')}</button>
      <button class="icon-btn sm danger" type="button" data-a="delete" aria-label="Delete" title="Delete (Del)">${icon('trash')}</button>`;
  }

  private patch(p: Partial<TextItem>): void {
    applyTextStyle(p);
    const prefs: Partial<typeof store.prefs> = {};
    if (p.font) prefs.textFont = p.font;
    if (p.size) prefs.textSize = p.size;
    if (p.bold !== undefined) prefs.textBold = p.bold;
    if (p.italic !== undefined) prefs.textItalic = p.italic;
    if (p.color) prefs.textColor = p.color;
    store.setPrefs(prefs);
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const { text, item } = this.target();
    const size = text?.size ?? store.prefs.textSize;
    if (b.dataset.color) {
      if (text || store.tool === 'text') this.patch({ color: b.dataset.color });
      else if (item && store.sel && 'color' in item) store.replaceItem(store.sel.key, { ...item, color: b.dataset.color } as Item);
      return;
    }
    switch (b.dataset.a) {
      case 'smaller':
        this.patch({ size: Math.max(4, Math.round((size - (size > 12 ? 2 : 1)) * 2) / 2) });
        break;
      case 'bigger':
        this.patch({ size: Math.min(96, Math.round((size + (size >= 12 ? 2 : 1)) * 2) / 2) });
        break;
      case 'bold':
        this.patch({ bold: !(text?.bold ?? store.prefs.textBold) });
        break;
      case 'italic':
        this.patch({ italic: !(text?.italic ?? store.prefs.textItalic) });
        break;
      case 'delete':
        this.onDelete();
        break;
      case 'duplicate':
        if (item && store.sel) {
          const copy = { ...item, id: uid('d') } as Item;
          const moved = 'x' in copy && 'y' in copy && copy.type !== 'note' ? { ...copy, x: (copy as { x: number }).x + 10, y: (copy as { y: number }).y + 10 } : copy;
          store.addItems(store.sel.key, [moved as Item]);
          store.select({ key: store.sel.key, id: moved.id });
        }
        break;
    }
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLSelectElement;
    if (el.id === 'ctx-font') this.patch({ font: el.value as FontFamily });
    if (el.id === 'ctx-size') this.patch({ size: Number(el.value) });
  }
}

const ITEM_LABELS: Record<Item['type'], string> = {
  ink: 'Ink',
  text: 'Text',
  mark: 'Checkmark',
  shape: 'Shape',
  note: 'Sticky note',
  stamp: 'Stamp',
  image: 'Image',
  markup: 'Text markup',
  link: 'Link',
  redact: 'Redaction mark',
  field: 'Form field',
};
