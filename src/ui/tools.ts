import type { Tool } from '../store';

export const TOOL_INFO: Record<Tool, { label: string; icon: string; key?: string }> = {
  select: { label: 'Select and move', icon: 'select', key: 'V' },
  hand: { label: 'Hand: scroll and fill forms', icon: 'hand', key: 'H' },
  text: { label: 'Add text', icon: 'text', key: 'T' },
  retype: { label: 'Edit existing text', icon: 'edit' },
  pen: { label: 'Pen', icon: 'pen', key: 'P' },
  highlighter: { label: 'Highlighter', icon: 'highlighter', key: 'M' },
  eraser: { label: 'Eraser', icon: 'eraser', key: 'E' },
  sign: { label: 'Handwritten signature', icon: 'sign', key: 'S' },
  mark: { label: 'Checkmark', icon: 'check' },
  note: { label: 'Sticky note', icon: 'note', key: 'N' },
  shape: { label: 'Shapes', icon: 'shapes', key: 'R' },
  markup: { label: 'Highlight text', icon: 'markHighlight', key: 'U' },
  stamp: { label: 'Stamp', icon: 'stamp' },
  image: { label: 'Image', icon: 'image' },
  link: { label: 'Link', icon: 'link' },
  redact: { label: 'Mark for redaction', icon: 'redact' },
  crop: { label: 'Crop pages', icon: 'crop' },
  field: { label: 'Form field', icon: 'form' },
};

export const QUICK_TOOLS: Tool[] = ['select', 'hand', 'text', 'pen', 'highlighter', 'eraser'];

export const SHAPE_COLORS = ['#d62f3f', '#2f3fd6', '#0f8a5f', '#1b1f2e'];
export const TEXT_COLORS = ['#1b1f2e', '#2f3fd6', '#d62f3f', '#0f8a5f'];
export const NOTE_COLORS = ['#ffd84a', '#7ee08a', '#ff8fc8', '#7cc7ff'];
export const MARKUP_COLORS = ['#ffd84a', '#7ee08a', '#ff8fc8', '#7cc7ff', '#d62f3f', '#2f3fd6'];

export const COLOR_NAMES: Record<string, string> = {
  '#1b1f2e': 'Black',
  '#2f3fd6': 'Blue',
  '#d62f3f': 'Red',
  '#0f8a5f': 'Green',
  '#ffd84a': 'Yellow',
  '#7ee08a': 'Green',
  '#ff8fc8': 'Pink',
  '#7cc7ff': 'Blue',
};

export const STAMPS: { label: string; color: string }[] = [
  { label: 'APPROVED', color: '#13804f' },
  { label: 'REJECTED', color: '#c42a35' },
  { label: 'DRAFT', color: '#2f3fd6' },
  { label: 'CONFIDENTIAL', color: '#c42a35' },
  { label: 'FINAL', color: '#13804f' },
  { label: 'FOR COMMENT', color: '#2f3fd6' },
  { label: 'REVIEWED', color: '#6b4fd6' },
  { label: 'PAID', color: '#13804f' },
];
