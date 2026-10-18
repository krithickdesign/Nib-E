// Interface language. Nib-E's texts are written in English inside the markup;
// this layer swaps each visible text (and tooltip, placeholder, label) for its
// translation as it appears, using the table in strings.ts. Anything without a
// translation stays in English. PDF content is never touched.
import { STRINGS } from './strings';

export type Lang = 'en' | 'de' | 'es' | 'fr' | 'pt-BR' | 'it';
export type LangPref = Lang | 'auto';

export const LANGUAGES: { id: LangPref; label: string }[] = [
  { id: 'auto', label: 'Same as the system' },
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'it', label: 'Italiano' },
];

const COLUMN: Record<Exclude<Lang, 'en'>, number> = { de: 0, es: 1, fr: 2, 'pt-BR': 3, it: 4 };
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
/** Never translate inside these: the PDF pages, notebook, editors and form inputs. */
const SKIP = '[translate="no"], .pages, .tab-name, .lib-name, script, style, textarea, [contenteditable="true"], .text-editor, svg';

/** The language to use for a preference ('auto' follows the system). */
export function resolveLang(pref: LangPref | undefined): Lang {
  if (pref && pref !== 'auto') return pref;
  const list = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const l of list) {
    const low = (l || '').toLowerCase();
    if (low.startsWith('pt')) return 'pt-BR';
    for (const c of ['de', 'es', 'fr', 'it'] as const) if (low === c || low.startsWith(`${c}-`)) return c;
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

let lang: Lang = 'en';
let table = new Map<string, string>();
let produced = new Set<string>();
const originals = new WeakMap<Node, string>();
const originalAttrs = new WeakMap<Element, Record<string, string>>();
let observer: MutationObserver | null = null;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function build(l: Lang): void {
  table = new Map();
  produced = new Set();
  if (l === 'en') return;
  const col = COLUMN[l];
  for (const [en, tr] of Object.entries(STRINGS)) {
    const v = tr[col];
    if (v) {
      table.set(en, v);
      produced.add(v);
    }
  }
}

/** Translation of one English text (the text itself when there is none). */
export function t(en: string): string {
  return table.get(norm(en)) ?? en;
}

export function currentLang(): Lang {
  return lang;
}

function skipped(el: Element | null): boolean {
  return !!el?.closest(SKIP);
}

function textNode(n: Text): void {
  const raw = n.nodeValue ?? '';
  if (!raw.trim()) return;
  const key = norm(raw);
  // Our own output, or a node already handled.
  if (produced.has(key) && originals.has(n)) return;
  const tr = table.get(key);
  if (!tr) return;
  if (skipped(n.parentElement)) return;
  originals.set(n, raw);
  const lead = raw.match(/^\s*/)![0];
  const trail = raw.match(/\s*$/)![0];
  const next = lead + tr + trail;
  if (next !== raw) n.nodeValue = next;
}

function element(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const tr = table.get(norm(v));
    if (!tr || tr === v) continue;
    if (skipped(el)) return;
    const o = originalAttrs.get(el) ?? {};
    if (!(a in o)) o[a] = v;
    originalAttrs.set(el, o);
    el.setAttribute(a, tr);
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return textNode(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root as Element)) return;
    element(root as Element);
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) textNode(n as Text);
    else element(n as Element);
  }
}

/** Puts every translated text back to English. */
function restore(): void {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const o = originals.get(n);
      if (o !== undefined) {
        n.nodeValue = o;
        originals.delete(n);
      }
    } else {
      const o = originalAttrs.get(n as Element);
      if (o) {
        for (const [a, v] of Object.entries(o)) (n as Element).setAttribute(a, v);
        originalAttrs.delete(n as Element);
      }
    }
  }
}

/** Starts (or switches) the interface language. */
export function setLanguage(pref: LangPref | undefined): Lang {
  const next = resolveLang(pref);
  if (next === lang && observer) return lang;
  observer?.disconnect();
  observer = null;
  if (lang !== 'en') restore();
  lang = next;
  build(lang);
  document.documentElement.lang = lang === 'pt-BR' ? 'pt-BR' : lang;
  if (lang === 'en') return lang;
  walk(document.body);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') textNode(r.target as Text);
      else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE) element(r.target as Element);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  return lang;
}
