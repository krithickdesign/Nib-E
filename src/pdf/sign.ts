// Certificate signing: signs a PDF with the person's own .p12/.pfx file.
//
// pdf-lib adds an empty signature (a signature field, its box and a value with
// space reserved for the signature), the file is written once, and then the
// reserved space is filled with a detached CMS signature (SHA-256, signed
// attributes) over every byte except that space. node-forge reads the .p12
// and makes the CMS. It is only used on the person's own certificate, never
// to check signatures from others (see signatures.ts for that).
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib';
import { isWinAnsi } from './core';

export interface SignOptions {
  p12: Uint8Array;
  password: string;
  reason?: string;
  location?: string;
  contact?: string;
  /** Page index (0-based) for the visible box. */
  page: number;
  /** Visible box in page points (top-left origin, crop box), or null for an invisible signature. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Time written into the signature (defaults to now). */
  when?: Date;
}

export interface Signer {
  name: string;
  issuer: string;
  notAfter: Date;
  selfSigned: boolean;
}

const PLACEHOLDER = '**********';
const RESERVE = 24576; // bytes reserved for the signature (certificate chains fit easily)

type Forge = typeof import('node-forge');
let forgeMod: Forge | null = null;
async function forge(): Promise<Forge> {
  if (!forgeMod) {
    const m = (await import('node-forge')) as unknown as Forge & { default?: Forge };
    forgeMod = (m.default ?? m) as Forge;
  }
  return forgeMod;
}

const toBinary = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

interface KeyPair {
  key: import('node-forge').pki.rsa.PrivateKey;
  cert: import('node-forge').pki.Certificate;
  chain: import('node-forge').pki.Certificate[];
}

const certName = (c: import('node-forge').pki.Certificate, which: 'subject' | 'issuer') => {
  const n = c[which];
  const v = (s: string) => {
    const raw = n.getField(s)?.value as string | undefined;
    if (!raw) return raw;
    try {
      return forgeMod!.util.decodeUtf8(raw);
    } catch {
      return raw;
    }
  };
  return v('CN') || [v('GN'), v('SN')].filter(Boolean).join(' ') || v('O') || v('E') || 'Unknown';
};

async function readP12(p12: Uint8Array, password: string): Promise<KeyPair> {
  const f = await forge();
  let obj: import('node-forge').pkcs12.Pkcs12Pfx;
  try {
    const asn = f.asn1.fromDer(toBinary(p12), false);
    obj = f.pkcs12.pkcs12FromAsn1(asn, false, password);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/mac|password|invalid/i.test(msg)) throw new Error('Wrong password for this certificate file.');
    if (/unsupported|oid/i.test(msg)) throw new Error('This certificate file uses an encryption Nib-E cannot read. Export it again as .p12/.pfx with "AES-256" or "TripleDES".');
    throw new Error(`This certificate file could not be read (${msg}).`);
  }
  const keyBags = [
    ...(obj.getBags({ bagType: f.pki.oids.pkcs8ShroudedKeyBag })[f.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(obj.getBags({ bagType: f.pki.oids.keyBag })[f.pki.oids.keyBag] ?? []),
  ];
  const certs = (obj.getBags({ bagType: f.pki.oids.certBag })[f.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is import('node-forge').pki.Certificate => !!c);
  const key = keyBags.map((b) => b.key).find(Boolean) as KeyPair['key'] | undefined;
  if (!key) {
    if (keyBags.length) throw new Error('Only RSA certificates can be used for signing for now.');
    throw new Error('This file has no private key. Use the .p12/.pfx that includes your key, not just the certificate.');
  }
  if (!certs.length) throw new Error('This file has no certificate.');
  // The certificate whose public key matches the private key.
  const cert =
    certs.find((c) => {
      const pub = c.publicKey as import('node-forge').pki.rsa.PublicKey;
      return pub?.n && pub.n.equals(key.n);
    }) ?? null;
  if (!cert) throw new Error('The certificate in this file does not match its key.');
  // Order the rest from the signer upwards where possible.
  const chain: KeyPair['cert'][] = [];
  let cur = cert;
  for (let guard = 0; guard < 8; guard++) {
    if (cur.isIssuer(cur)) break;
    const up = certs.find((c) => c !== cur && !chain.includes(c) && c.isIssuer(cur));
    if (!up) break;
    chain.push(up);
    cur = up;
  }
  for (const c of certs) if (c !== cert && !chain.includes(c)) chain.push(c);
  return { key, cert, chain };
}

/** Who a certificate file belongs to (checks the password too). */
export async function inspectP12(p12: Uint8Array, password: string): Promise<Signer> {
  const { cert } = await readP12(p12, password);
  return { name: certName(cert, 'subject'), issuer: certName(cert, 'issuer'), notAfter: cert.validity.notAfter, selfSigned: cert.isIssuer(cert) };
}

const pdfDateString = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

const winAnsi = (s: string) => [...s].map((c) => (isWinAnsi(c) ? c : '?')).join('');

function fieldName(doc: PDFDocument): string {
  const used = new Set(doc.getForm().getFields().map((f) => f.getName()));
  for (let n = 1; ; n++) if (!used.has(`Signature${n}`)) return `Signature${n}`;
}

/** The visible box: a thin frame with "Digitally signed by …", the date and the reason. */
function appearance(doc: PDFDocument, font: PDFFont, bold: PDFFont, w: number, h: number, lines: { text: string; bold?: boolean }[]): PDFRef {
  const pad = Math.min(6, h * 0.12);
  const rows = lines.length;
  let size = Math.min(11, (h - pad * 2) / (rows * 1.25));
  for (const l of lines) {
    const f = l.bold ? bold : font;
    const fit = (w - pad * 2) / Math.max(1, f.widthOfTextAtSize(l.text, 1));
    size = Math.min(size, fit);
  }
  size = Math.max(4, size);
  const lead = size * 1.25;
  const total = lead * rows;
  let y = h / 2 + total / 2 - size;
  let ops = `q 0.94 0.96 1 rg 0 0 ${w} ${h} re f 0.25 0.35 0.75 RG 0.8 w 0.4 0.4 ${w - 0.8} ${h - 0.8} re S Q\n`;
  ops += 'BT 0.1 0.12 0.2 rg\n';
  for (const l of lines) {
    const enc = (l.bold ? bold : font).encodeText(l.text).toString();
    ops += `/${l.bold ? 'F2' : 'F1'} ${size.toFixed(2)} Tf 1 0 0 1 ${pad.toFixed(2)} ${y.toFixed(2)} Tm ${enc} Tj\n`;
    y -= lead;
  }
  ops += 'ET';
  const stream = doc.context.stream(ops, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, h],
    Resources: { Font: { F1: font.ref, F2: bold.ref } },
  });
  return doc.context.register(stream);
}

async function addPlaceholder(bytes: Uint8Array, opts: SignOptions, who: string, when: Date): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e))) throw new Error('Remove the password protection first, then sign.');
    throw e;
  }
  if (doc.isEncrypted) throw new Error('Remove the password protection first, then sign.');
  const pages = doc.getPages();
  const page: PDFPage = pages[Math.min(Math.max(0, opts.page), pages.length - 1)];
  const ctx = doc.context;

  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PDFName.of(PLACEHOLDER), PDFName.of(PLACEHOLDER), PDFName.of(PLACEHOLDER)],
    Contents: PDFHexString.of('0'.repeat(RESERVE * 2)),
    M: PDFString.fromDate(when),
    Name: PDFHexString.fromText(who),
    Prop_Build: { App: { Name: 'Nib-E' } },
  });
  if (opts.reason) sig.set(PDFName.of('Reason'), PDFHexString.fromText(opts.reason));
  if (opts.location) sig.set(PDFName.of('Location'), PDFHexString.fromText(opts.location));
  if (opts.contact) sig.set(PDFName.of('ContactInfo'), PDFHexString.fromText(opts.contact));
  const sigRef = ctx.register(sig);

  let rect = [0, 0, 0, 0];
  let ap: PDFRef;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  if (opts.rect) {
    const box = page.getCropBox();
    const { x, y, w, h } = opts.rect;
    const x0 = box.x + x;
    const y1 = box.y + box.height - y;
    rect = [x0, y1 - h, x0 + w, y1];
    const lines = [
      { text: winAnsi(`Digitally signed by ${who}`), bold: true },
      { text: `Date: ${pdfDateString(when).slice(2, 6)}-${pdfDateString(when).slice(6, 8)}-${pdfDateString(when).slice(8, 10)} ${pdfDateString(when).slice(10, 12)}:${pdfDateString(when).slice(12, 14)} UTC` },
    ];
    if (opts.reason) lines.push({ text: winAnsi(`Reason: ${opts.reason}`) });
    if (opts.location) lines.push({ text: winAnsi(`Location: ${opts.location}`) });
    ap = appearance(doc, font, bold, w, h, lines);
  } else {
    ap = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] }));
  }

  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    V: sigRef,
    T: PDFHexString.fromText(fieldName(doc)),
    F: 4 | (opts.rect ? 0 : 2) | 128, // print, hidden when invisible, locked
    P: page.ref,
    AP: { N: ap },
  });
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  const form = doc.catalog.getOrCreateAcroForm();
  form.addField(widgetRef);
  form.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  // Existing form appearances stay as they are (do not regenerate them).
  form.dict.delete(PDFName.of('NeedAppearances'));

  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

/** Signs `bytes` (a finished PDF). Returns the signed file. Existing signatures in it stop being valid. */
export async function signPdf(bytes: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  const f = await forge();
  const { key, cert, chain } = await readP12(opts.p12, opts.password);
  const who = certName(cert, 'subject');
  const when = opts.when ?? new Date();
  if (when > cert.validity.notAfter) throw new Error(`This certificate expired on ${cert.validity.notAfter.toISOString().slice(0, 10)}.`);
  if (when < cert.validity.notBefore) throw new Error(`This certificate is only valid from ${cert.validity.notBefore.toISOString().slice(0, 10)}.`);

  const out = await addPlaceholder(bytes, opts, who, when);
  const text = latin1(out);

  // Locate our signature value: the placeholder byte range is unique.
  const brMatch = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(text);
  if (!brMatch) throw new Error('Could not prepare the signature (byte range not found).');
  const contentsTag = text.indexOf('/Contents', brMatch.index - RESERVE * 2 - 200);
  let start = -1;
  // Find the reserved hex string near the byte range (pdf-lib may write keys in any order).
  const zeros = '<' + '0'.repeat(RESERVE * 2) + '>';
  start = text.indexOf(zeros, Math.max(0, contentsTag));
  if (start < 0) start = text.indexOf(zeros);
  if (start < 0 || text.indexOf(zeros, start + 1) >= 0) throw new Error('Could not prepare the signature (reserved space not found).');
  const end = start + zeros.length;
  const range = [0, start, end, out.length - end];
  let br = `/ByteRange [${range.join(' ')}]`;
  if (br.length > brMatch[0].length) throw new Error('Could not prepare the signature (file too large).');
  br = br.padEnd(brMatch[0].length, ' ');
  for (let i = 0; i < br.length; i++) out[brMatch.index + i] = br.charCodeAt(i);

  // Detached CMS over both ranges.
  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]));
  signed.set(out.subarray(range[2]), range[1]);
  const p7 = f.pkcs7.createSignedData();
  p7.content = f.util.createBuffer(latin1(signed));
  p7.addCertificate(cert);
  for (const c of chain) p7.addCertificate(c);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: f.pki.oids.sha256,
    authenticatedAttributes: [
      { type: f.pki.oids.contentType, value: f.pki.oids.data },
      { type: f.pki.oids.messageDigest },
      { type: f.pki.oids.signingTime, value: when as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  const der = f.asn1.toDer(p7.toAsn1()).getBytes();
  if (der.length > RESERVE) throw new Error('The certificate chain is too large to fit.');
  let hex = '';
  for (let i = 0; i < der.length; i++) hex += der.charCodeAt(i).toString(16).padStart(2, '0');
  hex = hex.toUpperCase().padEnd(RESERVE * 2, '0');
  for (let i = 0; i < hex.length; i++) out[start + 1 + i] = hex.charCodeAt(i);
  return out;
}

export { pdfDateString };
