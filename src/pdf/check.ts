// Safe-mode document check. Nib-E never runs scripts (its PDF engine is built
// without a JavaScript runtime), never opens attachments and never follows
// links. This report tells the reader what the file contains anyway.
import { malloc, free, openRaw, pdfium } from './pdfium';

export type Level = 'blocked' | 'note';

export interface Finding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  count: number;
}

export interface CheckReport {
  findings: Finding[];
  encrypted: boolean;
  pagesScanned: number;
  pageCount: number;
}

const ACTION_REMOTEGOTO = 2;
const ACTION_URI = 3;
const ACTION_LAUNCH = 4;
const ACTION_EMBEDDEDGOTO = 5;
const MAX_LINK_PAGES = 400;

/** Counts PDF name tokens in the raw file (like the classic pdfid tool). */
function keywordCounts(bytes: Uint8Array): Record<string, number> {
  const keys = ['/JavaScript', '/JS', '/OpenAction', '/AA', '/Launch', '/EmbeddedFile', '/RichMedia', '/SubmitForm', '/ImportData', '/XFA', '/GoToR', '/GoToE'];
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const chunk = 1 << 20;
  for (let off = 0; off < bytes.length; off += chunk) {
    // Overlap chunks so a keyword split across a boundary is still found.
    const part = bytes.subarray(Math.max(0, off - 16), Math.min(bytes.length, off + chunk));
    let text = '';
    for (let i = 0; i < part.length; i += 8192) text += String.fromCharCode(...part.subarray(i, i + 8192));
    const start = off === 0 ? 0 : 16;
    for (const k of keys) {
      // Name must end at a delimiter so /JS does not match /JSON-ish names.
      const re = new RegExp(k.replace('/', '\\/') + '(?=[\\s/<>\\[\\]()%]|$)', 'g');
      let mt: RegExpExecArray | null;
      while ((mt = re.exec(text))) if (mt.index >= start) out[k] += 1;
    }
  }
  return out;
}

export function checkDocument(bytes: Uint8Array, password = ''): CheckReport {
  const m = pdfium();
  const kw = keywordCounts(bytes);
  const raw = openRaw(bytes, password);
  try {
    const D = raw.doc;
    const pageCount = m.FPDF_GetPageCount(D);
    const named = Math.max(0, m.FPDFDoc_GetJavaScriptActionCount(D));
    const attachments = Math.max(0, m.FPDFDoc_GetAttachmentCount(D));
    const signatures = Math.max(0, m.FPDF_GetSignatureCount(D));
    const formType = m.FPDF_GetFormType(D);

    let web = 0, launch = 0, remote = 0;
    const pagesScanned = Math.min(pageCount, MAX_LINK_PAGES);
    const posPtr = malloc(4);
    const linkPtr = malloc(4);
    try {
      for (let i = 0; i < pagesScanned; i++) {
        const page = m.FPDF_LoadPage(D, i);
        if (!page) continue;
        try {
          m.pdfium.setValue(posPtr, 0, 'i32');
          while (m.FPDFLink_Enumerate(page, posPtr, linkPtr)) {
            const link = m.pdfium.getValue(linkPtr, 'i32');
            const action = link ? m.FPDFLink_GetAction(link) : 0;
            const type = action ? m.FPDFAction_GetType(action) : 0;
            if (type === ACTION_URI) web += 1;
            else if (type === ACTION_LAUNCH) launch += 1;
            else if (type === ACTION_REMOTEGOTO || type === ACTION_EMBEDDEDGOTO) remote += 1;
          }
        } finally {
          m.FPDF_ClosePage(page);
        }
      }
    } finally {
      free(posPtr);
      free(linkPtr);
    }

    const findings: Finding[] = [];
    // Every script action carries a /JS key; named document scripts also sit under /JavaScript.
    const scripts = Math.max(named, kw['/JS'], kw['/JavaScript'] ? 1 : 0);
    if (scripts) {
      findings.push({
        id: 'scripts', level: 'blocked', count: scripts, title: 'Scripts',
        detail: kw['/OpenAction'] ? 'This file tries to run code. Some of it may start when the file opens. Nib-E cannot run scripts, so none of it ran.' : 'This file contains code. Nib-E cannot run scripts, so none of it ran.',
      });
    }
    const launches = Math.max(launch, kw['/Launch']);
    if (launches) {
      findings.push({ id: 'launch', level: 'blocked', count: launches, title: 'Program launchers', detail: 'Links that try to open programs or files on your computer. Nib-E ignores them.' });
    }
    if (kw['/SubmitForm'] || kw['/ImportData']) {
      findings.push({ id: 'submit', level: 'blocked', count: kw['/SubmitForm'] + kw['/ImportData'], title: 'Form submission', detail: 'Buttons that send form data to a server. Nib-E never sends anything.' });
    }
    if (attachments || kw['/EmbeddedFile']) {
      findings.push({ id: 'attachments', level: 'blocked', count: Math.max(attachments, kw['/EmbeddedFile'] ? 1 : 0), title: 'Attached files', detail: 'Files hidden inside this PDF. Nib-E does not open or extract them.' });
    }
    if (kw['/RichMedia']) {
      findings.push({ id: 'media', level: 'blocked', count: kw['/RichMedia'], title: 'Embedded media', detail: 'Video, audio or Flash content. Nib-E does not play it.' });
    }
    if (remote || kw['/GoToR'] || kw['/GoToE']) {
      findings.push({ id: 'remote', level: 'blocked', count: Math.max(remote, kw['/GoToR'] + kw['/GoToE']), title: 'Links to other files', detail: 'Jumps into other documents. Nib-E does not follow them.' });
    }
    if (web) {
      findings.push({ id: 'web', level: 'note', count: web, title: 'Web links', detail: 'Links to websites. They are not clickable in safe mode.' });
    }
    if (formType === 1) {
      findings.push({ id: 'form', level: 'note', count: 1, title: 'Fillable form', detail: 'Text fields and checkboxes you can fill with the hand tool.' });
    } else if (formType === 2 || formType === 3 || kw['/XFA']) {
      findings.push({ id: 'xfa', level: 'note', count: 1, title: 'XFA form', detail: 'An older dynamic form type. Nib-E shows it but cannot fill it yet.' });
    }
    if (signatures) {
      findings.push({ id: 'signatures', level: 'note', count: signatures, title: 'Digital signatures', detail: 'Nib-E shows signed files but does not verify signatures yet. Saving changes breaks an existing signature.' });
    }
    return { findings, encrypted: false, pagesScanned, pageCount };
  } finally {
    raw.close();
  }
}
