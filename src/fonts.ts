// Fonts for typed text. The three standard PDF fonts need nothing extra (every
// reader has them, but they only store Western European characters). The other
// fonts are free (SIL Open Font License, see assets/fonts/LICENSES.md), bundled
// with Nib-E, shown on screen from the same files and embedded into saved PDFs,
// so text looks the same everywhere and may use any character the font has.
import interR from './assets/fonts/Inter_400Regular.ttf?url';
import interB from './assets/fonts/Inter_700Bold.ttf?url';
import interI from './assets/fonts/Inter_400Regular_Italic.ttf?url';
import interBI from './assets/fonts/Inter_700Bold_Italic.ttf?url';
import notoR from './assets/fonts/NotoSans_400Regular.ttf?url';
import notoB from './assets/fonts/NotoSans_700Bold.ttf?url';
import notoI from './assets/fonts/NotoSans_400Regular_Italic.ttf?url';
import notoBI from './assets/fonts/NotoSans_700Bold_Italic.ttf?url';
import ssR from './assets/fonts/SourceSerif4_400Regular.ttf?url';
import ssB from './assets/fonts/SourceSerif4_700Bold.ttf?url';
import ssI from './assets/fonts/SourceSerif4_400Regular_Italic.ttf?url';
import ssBI from './assets/fonts/SourceSerif4_700Bold_Italic.ttf?url';
import pfR from './assets/fonts/PlayfairDisplay_400Regular.ttf?url';
import pfB from './assets/fonts/PlayfairDisplay_700Bold.ttf?url';
import pfI from './assets/fonts/PlayfairDisplay_400Regular_Italic.ttf?url';
import pfBI from './assets/fonts/PlayfairDisplay_700Bold_Italic.ttf?url';
import rcR from './assets/fonts/RobotoCondensed_400Regular.ttf?url';
import rcB from './assets/fonts/RobotoCondensed_700Bold.ttf?url';
import rcI from './assets/fonts/RobotoCondensed_400Regular_Italic.ttf?url';
import rcBI from './assets/fonts/RobotoCondensed_700Bold_Italic.ttf?url';
import cavR from './assets/fonts/Caveat_400Regular.ttf?url';
import cavB from './assets/fonts/Caveat_700Bold.ttf?url';

export type StdFont = 'sans' | 'serif' | 'mono';
export type BundledFont = 'inter' | 'noto' | 'sourceserif' | 'playfair' | 'condensed' | 'caveat';
export type FontId = StdFont | BundledFont;

interface Files {
  r: string;
  b: string;
  i?: string;
  bi?: string;
}

export interface FontDef {
  id: FontId;
  label: string;
  /** What it is good for (shown in the menu). */
  kind: string;
  /** Bundled font files; none for the standard PDF fonts. */
  files?: Files;
  /** Serif, sans or mono look (used to pick the closest font for replaced text). */
  look: StdFont;
}

export const FONTS: FontDef[] = [
  { id: 'sans', label: 'Arial / Helvetica', kind: 'Standard', look: 'sans' },
  { id: 'serif', label: 'Times', kind: 'Standard', look: 'serif' },
  { id: 'mono', label: 'Courier', kind: 'Standard', look: 'mono' },
  { id: 'inter', label: 'Inter', kind: 'Modern sans', look: 'sans', files: { r: interR, b: interB, i: interI, bi: interBI } },
  { id: 'noto', label: 'Noto Sans', kind: 'Many languages', look: 'sans', files: { r: notoR, b: notoB, i: notoI, bi: notoBI } },
  { id: 'condensed', label: 'Roboto Condensed', kind: 'Narrow', look: 'sans', files: { r: rcR, b: rcB, i: rcI, bi: rcBI } },
  { id: 'sourceserif', label: 'Source Serif', kind: 'Book serif', look: 'serif', files: { r: ssR, b: ssB, i: ssI, bi: ssBI } },
  { id: 'playfair', label: 'Playfair Display', kind: 'Headline serif', look: 'serif', files: { r: pfR, b: pfB, i: pfI, bi: pfBI } },
  { id: 'caveat', label: 'Caveat', kind: 'Handwriting', look: 'sans', files: { r: cavR, b: cavB } },
];

const byId = new Map(FONTS.map((f) => [f.id, f]));

export function fontDef(id: string): FontDef {
  return byId.get(id as FontId) ?? FONTS[0];
}

export function isBundled(id: string): id is BundledFont {
  return !!byId.get(id as FontId)?.files;
}

/** CSS family name used for a bundled font on screen. */
export function cssFamily(id: BundledFont): string {
  return `"Nib ${fontDef(id).label}"`;
}

function fileFor(def: FontDef, bold: boolean, italic: boolean): string {
  const f = def.files!;
  if (bold && italic) return f.bi ?? f.b;
  if (bold) return f.b;
  if (italic) return f.i ?? f.r;
  return f.r;
}

/** Whether the font has a real italic (others are shown and saved upright). */
export function hasItalic(id: string): boolean {
  const d = fontDef(id);
  return !d.files || !!d.files.i;
}

const bytesCache = new Map<string, Promise<Uint8Array>>();

async function toBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load a font (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The TrueType file of a bundled font style (for embedding into a PDF). */
export function fontBytes(id: BundledFont, bold: boolean, italic: boolean): Promise<Uint8Array> {
  const url = fileFor(fontDef(id), bold, italic);
  let p = bytesCache.get(url);
  if (!p) {
    p = toBytes(url);
    bytesCache.set(url, p);
  }
  return p;
}

let loading: Promise<void> | null = null;

/**
 * Registers every bundled font with the page so text can be drawn and measured
 * with it. Resolves when they are ready; `onReady` lets the caller repaint.
 */
export function loadScreenFonts(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
    const jobs: Promise<unknown>[] = [];
    for (const def of FONTS) {
      if (!def.files) continue;
      for (const [bold, italic] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        if (italic && !def.files.i) continue;
        jobs.push(
          fontBytes(def.id as BundledFont, bold, italic).then(async (bytes) => {
            const face = new FontFace(`Nib ${def.label}`, bytes.slice().buffer as ArrayBuffer, { weight: bold ? '700' : '400', style: italic ? 'italic' : 'normal' });
            await face.load();
            document.fonts.add(face);
          }),
        );
      }
    }
    await Promise.allSettled(jobs);
  })();
  return loading;
}
