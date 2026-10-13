// Turns a document's edits (the plan) into plain data and back, for:
//  - the study library (notes kept on this device, matched to the book file)
//  - crash recovery (unsaved work survives a closed tab or a crash)
//  - notes written into the book file (option B, see pdf/nibdata.ts)
import type { HeaderFooter, PageEntry, Plan, Watermark } from './model';
import type { DocState } from './store';
import { images } from './ui/draw';

export interface StoredImage {
  mime: 'image/jpeg' | 'image/png';
  w: number;
  h: number;
  bytes: Uint8Array;
}

/** A page with its source given as a position in the source list (0 = the opened file). */
export type StoredPage = Omit<PageEntry, 'src'> & { src: number | null };

export interface StoredPlan {
  v: 1;
  pages: StoredPage[];
  notes: PageEntry[];
  hf: HeaderFooter | null;
  wm: Watermark | null;
  images: Record<string, StoredImage>;
}

/** Source ids in a fixed order: the opened file first, then merged files. */
export function sourceOrder(state: DocState): string[] {
  return [state.primary, ...[...state.sources.keys()].filter((k) => k !== state.primary)];
}

function imageIds(pages: PageEntry[]): string[] {
  const ids = new Set<string>();
  for (const p of pages) for (const it of p.items) if (it.type === 'image') ids.add(it.image);
  return [...ids];
}

export function snapshot(state: DocState, plan: Plan = state.plan): StoredPlan {
  const order = sourceOrder(state);
  const imgs: Record<string, StoredImage> = {};
  for (const id of imageIds([...plan.pages, ...plan.notes])) {
    const img = images.get(id);
    if (img) imgs[id] = { mime: img.mime as StoredImage['mime'], w: img.w, h: img.h, bytes: img.bytes };
  }
  return {
    v: 1,
    pages: plan.pages.map((p) => ({ ...p, src: p.src === null ? null : order.indexOf(p.src) })),
    notes: plan.notes,
    hf: plan.hf,
    wm: plan.wm,
    images: imgs,
  };
}

/** Puts stored images back into the image registry (needed before drawing). */
export async function restoreImages(stored: Record<string, StoredImage>): Promise<void> {
  for (const [id, img] of Object.entries(stored ?? {})) {
    if (images.has(id)) continue;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.mime }));
    } catch {
      /* drawn as missing; still saved into PDFs */
    }
    images.set(id, { bytes: img.bytes, mime: img.mime, w: img.w, h: img.h, bitmap });
  }
}

/**
 * Builds a plan for `state` from stored data. `srcIds[i]` is the source id that
 * stored position i now has; pages whose source is gone are dropped.
 */
export function rebuild(stored: StoredPlan, srcIds: (string | undefined)[]): { plan: Plan; dropped: number } {
  let dropped = 0;
  const pages: PageEntry[] = [];
  for (const p of stored.pages) {
    if (p.src === null) {
      pages.push({ ...p, src: null });
      continue;
    }
    const id = srcIds[p.src];
    if (!id) {
      dropped += 1;
      continue;
    }
    pages.push({ ...p, src: id });
  }
  return { plan: { pages, notes: stored.notes ?? [], hf: stored.hf ?? null, wm: stored.wm ?? null }, dropped };
}

/** True when the plan holds anything worth keeping. */
export function hasWork(plan: Plan): boolean {
  return plan.pages.some((p) => p.items.length) || plan.notes.some((p) => p.items.length) || !!plan.hf || !!plan.wm;
}
