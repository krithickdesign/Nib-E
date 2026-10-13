// Drawn signatures: draw once in a pad, then tap a page to place it.
// The signature is saved in this browser only (never uploaded).
import { drawLive } from '../ink/stroke';
import { toPage, uid, type InkItem, type PageEntry, type Pt } from '../model';

export interface Signature {
  strokes: { pts: Pt[]; sim: boolean }[];
  w: number;
  h: number;
}

const KEY = 'nib.signature.v1';
const PAD_PEN = 3.4; // pad pixels
const PLACE_WIDTH = 150; // points

export function savedSignature(): Signature | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Signature) : null;
  } catch {
    return null;
  }
}

let memory: Signature | null = null;

export async function getSignature(): Promise<Signature | null> {
  return memory ?? savedSignature() ?? openSignaturePad();
}

export function hasSignature(): boolean {
  return !!(memory ?? savedSignature());
}

export function placeSignature(sig: Signature, entry: PageEntry, cx: number, cy: number, color: string): InkItem[] {
  const scale = PLACE_WIDTH / Math.max(1, sig.w);
  return sig.strokes.map((s) => ({
    id: uid('s'),
    type: 'ink' as const,
    kind: 'pen' as const,
    color,
    size: Math.max(0.8, PAD_PEN * scale),
    sim: s.sim,
    pts: s.pts.map(([x, y, p]) => {
      const [ux, uy] = toPage(entry, cx + (x - sig.w / 2) * scale, cy + (y - sig.h / 2) * scale);
      return [ux, uy, p] as Pt;
    }),
  }));
}

/** Opens the signature pad. Resolves with the new signature, or null if cancelled. */
export function openSignaturePad(): Promise<Signature | null> {
  const dlg = document.getElementById('sign-dialog') as HTMLDialogElement;
  const canvas = dlg.querySelector('canvas') as HTMLCanvasElement;
  const clearBtn = dlg.querySelector('[data-act="clear"]') as HTMLButtonElement;
  const useBtn = dlg.querySelector('[data-act="use"]') as HTMLButtonElement;
  const cancelBtn = dlg.querySelector('[data-act="cancel"]') as HTMLButtonElement;
  const remember = dlg.querySelector('#sign-remember') as HTMLInputElement;
  const ctx = canvas.getContext('2d')!;
  const strokes: { pts: Pt[]; sim: boolean }[] = [];
  let current: { pts: Pt[]; sim: boolean } | null = null;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);

  const sizeCanvas = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * ratio));
    canvas.height = Math.max(1, Math.round(r.height * ratio));
    redraw();
  };
  const ink = '#1b1f2e'; // the pad is always white paper
  const redraw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const s of current ? [...strokes, current] : strokes) drawLive(ctx, { kind: 'pen', color: ink, size: PAD_PEN, sim: s.sim, pts: s.pts });
    useBtn.disabled = strokes.length === 0;
  };
  const point = (e: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' && e.pressure ? e.pressure : 0.5];
  };
  const down = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    current = { pts: [point(e)], sim: e.pointerType !== 'pen' };
    redraw();
  };
  const move = (e: PointerEvent) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) current.pts.push(point(ev));
    redraw();
  };
  const up = () => {
    if (current && current.pts.length) strokes.push(current);
    current = null;
    redraw();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  const onClear = () => {
    strokes.length = 0;
    redraw();
  };
  clearBtn.addEventListener('click', onClear);

  return new Promise((resolve) => {
    const finish = (sig: Signature | null) => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      clearBtn.removeEventListener('click', onClear);
      useBtn.onclick = null;
      cancelBtn.onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(sig);
    };
    useBtn.onclick = () => {
      const all = strokes.flatMap((s) => s.pts);
      if (!all.length) return;
      const minX = Math.min(...all.map((p) => p[0]));
      const minY = Math.min(...all.map((p) => p[1]));
      const maxX = Math.max(...all.map((p) => p[0]));
      const maxY = Math.max(...all.map((p) => p[1]));
      const sig: Signature = {
        w: Math.max(1, maxX - minX),
        h: Math.max(1, maxY - minY),
        strokes: strokes.map((s) => ({ sim: s.sim, pts: s.pts.map(([x, y, p]) => [x - minX, y - minY, p] as Pt) })),
      };
      memory = sig;
      try {
        if (remember.checked) localStorage.setItem(KEY, JSON.stringify(sig));
        else localStorage.removeItem(KEY);
      } catch {
        /* storage unavailable: keep it for this session only */
      }
      finish(sig);
    };
    cancelBtn.onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    requestAnimationFrame(sizeCanvas);
  });
}
