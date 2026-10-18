// Copy, cut, paste and duplicate for items Nib-E added (text boxes, shapes,
// stamps, images, ink…). The clipboard is Nib-E's own, kept in memory: items
// can be pasted onto another page or into another open file.
import { itemBounds, moveItem, uid, type Item } from '../model';
import { store } from '../store';
import { toast } from './toast';

let clip: { item: Item; key: string; pastes: number } | null = null;

const OFFSET = 12;

function selectedItem(): { item: Item; key: string } | null {
  const sel = store.sel;
  if (!sel) return null;
  const item = store.findItem(sel.key, sel.id);
  return item ? { item, key: sel.key } : null;
}

/** A copy with a new id, no longer tied to a detected form box. */
function fresh(it: Item): Item {
  const c = { ...it, id: uid('c') } as Item & { field?: string };
  if ('field' in c) delete c.field;
  return c as Item;
}

/** Moves an item by (dx, dy) but keeps it on the page. */
function placed(it: Item, key: string, dx: number, dy: number): Item {
  const page = store.findPage(key)?.page;
  let out = moveItem(it, dx, dy);
  if (!page) return out;
  const b = itemBounds(out);
  const fx = b.x + b.w > page.w ? page.w - (b.x + b.w) : b.x < 0 ? -b.x : 0;
  const fy = b.y + b.h > page.h ? page.h - (b.y + b.h) : b.y < 0 ? -b.y : 0;
  if (fx || fy) out = moveItem(out, fx, fy);
  return out;
}

export function hasClip(): boolean {
  return !!clip;
}

export function copySelection(): boolean {
  const s = selectedItem();
  if (!s) return false;
  clip = { item: s.item, key: s.key, pastes: 0 };
  toast('Copied. Ctrl+V pastes it, also on another page.');
  return true;
}

export function cutSelection(): boolean {
  const s = selectedItem();
  if (!s) return false;
  clip = { item: s.item, key: s.key, pastes: -1 };
  store.removeItems(s.key, new Set([s.item.id]));
  store.select(null);
  return true;
}

/** Pastes onto the page of the selection, else the current page. */
export function pasteClipboard(): boolean {
  if (!clip || !store.doc) return false;
  const key = store.sel?.key ?? store.pages[store.current]?.key;
  if (!key || !store.findPage(key)) return false;
  // Same page: a little down and right of the last copy. Another page: same place.
  const same = key === clip.key;
  clip.pastes += 1;
  const step = same ? OFFSET * Math.max(1, clip.pastes) : 0;
  const item = placed(fresh(clip.item), key, step, step);
  store.addItems(key, [item]);
  store.select({ key, id: item.id });
  return true;
}

/** Ctrl+D or the ⧉ button: a copy next to the selected item (the clipboard stays as it is). */
export function duplicateSelection(): boolean {
  const s = selectedItem();
  if (!s) return false;
  const item = placed(fresh(s.item), s.key, OFFSET, OFFSET);
  store.addItems(s.key, [item]);
  store.select({ key: s.key, id: item.id });
  return true;
}
