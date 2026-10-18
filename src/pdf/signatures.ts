// Digital signatures: reading and checking the ones in a PDF.
//
// The check is done here, offline, with WebCrypto:
//   1. the bytes the signature covers (its /ByteRange) are hashed,
//   2. the hash is compared with the one inside the signature (CMS messageDigest),
//   3. the signature value is verified with the signer's public key,
//   4. the certificates inside the file are linked up to see who issued whose.
// Trust lists (is the issuer a real certificate authority?) and revocation
// (was the certificate withdrawn?) need the internet and are NOT checked.
import { free, heap, malloc, openRaw, pdfium } from './core';
import * as A from './asn1';

export type SigStatus = 'valid' | 'changed' | 'invalid' | 'unknown';

export interface CertInfo {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  notBefore: Date | null;
  notAfter: Date | null;
  selfSigned: boolean;
  serial: string;
}

export interface SignatureReport {
  index: number;
  status: SigStatus;
  /** One plain sentence for the person. */
  summary: string;
  /** Extra plain sentences (coverage, certificate dates, chain). */
  notes: string[];
  signer: string;
  signerCert: CertInfo | null;
  /** Certificates from the signer upwards, as far as the file has them. */
  chain: CertInfo[];
  reason: string;
  time: Date | null;
  subFilter: string;
  timestamp: boolean;
  /** The signature covers the whole file as it is now. */
  coversAll: boolean;
  /** Bytes covered (end of the second range). */
  coveredBytes: number;
  digest: string;
}

// ---------- reading signature objects with PDFium ----------

function readBytes(fn: (buf: number, len: number) => number): Uint8Array {
  const need = fn(0, 0);
  if (need <= 0) return new Uint8Array();
  const p = malloc(need);
  try {
    const got = fn(p, need);
    return heap().slice(p, p + Math.min(got, need));
  } finally {
    free(p);
  }
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b).replace(/\0+$/, '');
const utf16 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
  return s.replace(/\0+$/, '');
};

/** PDF date "D:YYYYMMDDHHmmSS+HH'mm'" → Date. */
export function pdfDate(s: string): Date | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s.trim());
  if (!m) return null;
  let ms = Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (m[7] === '+' || m[7] === '-') ms -= (m[7] === '-' ? -1 : 1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0)) * 60000;
  return new Date(ms);
}

interface RawSig {
  contents: Uint8Array;
  range: number[];
  subFilter: string;
  reason: string;
  time: string;
}

function rawSignatures(bytes: Uint8Array, password = ''): RawSig[] {
  const m = pdfium();
  const raw = openRaw(bytes, password);
  try {
    const n = Math.max(0, m.FPDF_GetSignatureCount(raw.doc));
    const out: RawSig[] = [];
    for (let i = 0; i < n; i++) {
      const s = m.FPDF_GetSignatureObject(raw.doc, i);
      if (!s) continue;
      const contents = readBytes((b, l) => m.FPDFSignatureObj_GetContents(s, b, l));
      const count = m.FPDFSignatureObj_GetByteRange(s, 0, 0);
      let range: number[] = [];
      if (count > 0) {
        const p = malloc(count * 4);
        try {
          m.FPDFSignatureObj_GetByteRange(s, p, count);
          range = Array.from(new Int32Array(heap().buffer.slice(p, p + count * 4)));
        } finally {
          free(p);
        }
      }
      out.push({
        contents,
        range,
        subFilter: ascii(readBytes((b, l) => m.FPDFSignatureObj_GetSubFilter(s, b, l))),
        reason: utf16(readBytes((b, l) => m.FPDFSignatureObj_GetReason(s, b, l))),
        time: ascii(readBytes((b, l) => m.FPDFSignatureObj_GetTime(s, b, l))),
      });
    }
    return out;
  } finally {
    raw.close();
  }
}

// ---------- certificates ----------

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ec: '1.2.840.10045.2.1',
  ski: '2.5.29.14',
};

const HASH_OIDS: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

/** Signature algorithm OIDs → [key kind, hash] (hash '' = take the digest algorithm). */
const SIG_OIDS: Record<string, [string, string]> = {
  '1.2.840.113549.1.1.1': ['rsa', ''],
  '1.2.840.113549.1.1.5': ['rsa', 'SHA-1'],
  '1.2.840.113549.1.1.11': ['rsa', 'SHA-256'],
  '1.2.840.113549.1.1.12': ['rsa', 'SHA-384'],
  '1.2.840.113549.1.1.13': ['rsa', 'SHA-512'],
  '1.2.840.113549.1.1.10': ['pss', ''],
  '1.2.840.10045.2.1': ['ec', ''],
  '1.2.840.10045.4.1': ['ec', 'SHA-1'],
  '1.2.840.10045.4.3.2': ['ec', 'SHA-256'],
  '1.2.840.10045.4.3.3': ['ec', 'SHA-384'],
  '1.2.840.10045.4.3.4': ['ec', 'SHA-512'],
};

const CURVES: Record<string, [string, number]> = {
  '1.2.840.10045.3.1.7': ['P-256', 32],
  '1.3.132.0.34': ['P-384', 48],
  '1.3.132.0.35': ['P-521', 66],
};

interface Cert {
  der: Uint8Array;
  tbs: Uint8Array;
  sigAlg: string;
  sigAlgParams: A.Node | null;
  sig: Uint8Array;
  serial: Uint8Array;
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  spki: Uint8Array;
  keyAlg: string;
  curve: string;
  ski: Uint8Array | null;
  info: CertInfo;
}

function readCert(buf: Uint8Array, n: A.Node): Cert {
  const [tbsN, algN, sigN] = n.kids;
  const t = tbsN.kids;
  let k = 0;
  if (t[0].cls === 2 && t[0].tag === 0) k++; // [0] version
  const serialN = t[k++];
  k++; // signature algorithm (inside tbs)
  const issuerN = t[k++];
  const validityN = t[k++];
  const subjectN = t[k++];
  const spkiN = t[k++];
  let ski: Uint8Array | null = null;
  for (; k < t.length; k++) {
    if (t[k].cls === 2 && t[k].tag === 3 && t[k].kids[0]) {
      for (const ext of t[k].kids[0].kids) {
        if (A.oid(buf, ext.kids[0]) !== OID.ski) continue;
        const val = ext.kids[ext.kids.length - 1];
        try {
          const inner = A.parse(A.content(buf, val));
          ski = A.content(A.content(buf, val), inner).slice();
        } catch {
          /* ignore a broken extension */
        }
      }
    }
  }
  const keyAlgN = spkiN.kids[0];
  const keyAlg = A.oid(buf, keyAlgN.kids[0]);
  const curve = keyAlg === OID.ec && keyAlgN.kids[1]?.tag === A.TAG.OID ? A.oid(buf, keyAlgN.kids[1]) : '';
  const sigBits = A.content(buf, sigN);
  const issuerDer = A.whole(buf, issuerN).slice();
  const subjectDer = A.whole(buf, subjectN).slice();
  const serial = A.content(buf, serialN).slice();
  return {
    der: A.whole(buf, n).slice(),
    tbs: A.whole(buf, tbsN).slice(),
    sigAlg: A.oid(buf, algN.kids[0]),
    sigAlgParams: algN.kids[1] ?? null,
    sig: sigBits.slice(1),
    serial,
    issuerDer,
    subjectDer,
    spki: A.whole(buf, spkiN).slice(),
    keyAlg,
    curve,
    ski,
    info: {
      subject: A.name(buf, subjectN),
      issuer: A.name(buf, issuerN),
      notBefore: A.time(buf, validityN.kids[0]),
      notAfter: A.time(buf, validityN.kids[1]),
      selfSigned: A.equalBytes(issuerDer, subjectDer),
      serial: A.hex(serial),
    },
  };
}

export function personName(n: Record<string, string>): string {
  return n.CN || [n.GN, n.SN].filter(Boolean).join(' ') || n.O || n.E || 'Unknown signer';
}

// ---------- WebCrypto ----------

const bs = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser cannot check signatures (no Web Crypto).');
  return s;
};

async function digest(hash: string, parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await subtle().digest(hash, bs(all)));
}

/** DER ECDSA signature (SEQUENCE of r, s) → raw r||s as WebCrypto expects. */
function ecdsaRaw(der: Uint8Array, size: number): Uint8Array {
  const n = A.parse(der);
  const out = new Uint8Array(size * 2);
  n.kids.slice(0, 2).forEach((k, i) => {
    let v = A.content(der, k);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('Bad ECDSA value');
    out.set(v, i * size + size - v.length);
  });
  return out;
}

/** PSS parameters: hash and salt length (defaults SHA-1, 20). */
function pssParams(buf: Uint8Array | null, n: A.Node | null): { hash: string; salt: number } {
  let hash = 'SHA-1';
  let salt = 20;
  if (buf && n)
    for (const k of n.kids) {
      if (k.cls !== 2) continue;
      if (k.tag === 0 && k.kids[0]) hash = HASH_OIDS[A.oid(buf, k.kids[0].kids[0])] ?? hash;
      if (k.tag === 2 && k.kids[0]) salt = A.content(buf, k.kids[0]).reduce((a, b) => a * 256 + b, 0);
    }
  return { hash, salt };
}

/**
 * Verifies `sig` over `data` with the certificate's key. `algOid` is the
 * signature algorithm; `fallbackHash` is used when the OID does not name one.
 */
async function verifyWith(cert: Cert, algOid: string, params: { buf: Uint8Array; node: A.Node | null } | null, fallbackHash: string, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  const known = SIG_OIDS[algOid];
  const kind = known?.[0] ?? (cert.keyAlg === OID.ec ? 'ec' : cert.keyAlg === OID.rsaPss ? 'pss' : 'rsa');
  const hash = known?.[1] || fallbackHash;
  try {
    if (kind === 'ec') {
      const c = CURVES[cert.curve];
      if (!c) return false;
      const key = await subtle().importKey('spki', bs(cert.spki), { name: 'ECDSA', namedCurve: c[0] }, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash }, key, bs(ecdsaRaw(sig, c[1])), bs(data));
    }
    if (kind === 'pss') {
      const p = pssParams(params?.buf ?? null, params?.node ?? null);
      // WebCrypto only imports PSS keys published as plain RSA keys.
      const spki = cert.keyAlg === OID.rsaPss ? rsaSpki(cert) : cert.spki;
      const key = await subtle().importKey('spki', bs(spki), { name: 'RSA-PSS', hash: p.hash }, false, ['verify']);
      return await subtle().verify({ name: 'RSA-PSS', saltLength: p.salt }, key, bs(sig), bs(data));
    }
    const key = await subtle().importKey('spki', bs(cert.spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return await subtle().verify('RSASSA-PKCS1-v1_5', key, bs(sig), bs(data));
  } catch {
    return false;
  }
}

/** A copy of an RSA-PSS key re-labelled as plain RSA (same key bytes). */
function rsaSpki(cert: Cert): Uint8Array {
  const n = A.parse(cert.spki);
  const bits = A.whole(cert.spki, n.kids[1]);
  const alg = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return seq([alg, bits]);
}

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const b: number[] = [];
  while (n) {
    b.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | b.length, ...b];
}

function seq(parts: Uint8Array[], tag = 0x30): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const head = [tag, ...derLen(len)];
  const out = new Uint8Array(head.length + len);
  out.set(head);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- CMS ----------

interface Parsed {
  certs: Cert[];
  signer: Cert | null;
  digestAlg: string;
  signedAttrs: Uint8Array | null;
  messageDigest: Uint8Array | null;
  signingTime: Date | null;
  sigAlg: string;
  sigAlgParams: A.Node | null;
  signature: Uint8Array;
  /** Encapsulated content (adbe.pkcs7.sha1 digest, or TSTInfo for timestamps). */
  econtentType: string;
  econtent: Uint8Array | null;
  buf: Uint8Array;
  hasTimestamp: boolean;
}

function parseCms(der: Uint8Array): Parsed {
  const root = A.parse(der);
  // Drop the zero padding after the structure (signatures reserve space).
  const buf = der.subarray(0, root.end);
  if (A.oid(buf, root.kids[0]) !== OID.signedData) throw new Error('Not a CMS signature');
  const sd = root.kids[1].kids[0];
  const k = sd.kids;
  let i = 1; // version
  const digestAlgs = k[i++];
  const encap = k[i++];
  const certs: Cert[] = [];
  let signerInfos: A.Node | null = null;
  for (; i < k.length; i++) {
    const n = k[i];
    if (n.cls === 2 && n.tag === 0) {
      for (const c of n.kids) if (c.tag === A.TAG.SEQ && c.cls === 0) {
        try {
          certs.push(readCert(buf, c));
        } catch {
          /* skip certificates we cannot read */
        }
      }
    } else if (n.cls === 0 && n.tag === A.TAG.SET) signerInfos = n;
  }
  const econtentType = A.oid(buf, encap.kids[0]);
  let econtent: Uint8Array | null = null;
  if (encap.kids[1]) econtent = A.octets(buf, encap.kids[1].kids[0]);
  const si = signerInfos?.kids[0];
  if (!si) throw new Error('No signer in the signature');
  const s = si.kids;
  let j = 1;
  const sid = s[j++];
  const digestAlg = HASH_OIDS[A.oid(buf, s[j++].kids[0])] ?? HASH_OIDS[A.oid(buf, digestAlgs.kids[0]?.kids[0])] ?? '';
  let signedAttrs: Uint8Array | null = null;
  let messageDigest: Uint8Array | null = null;
  let signingTime: Date | null = null;
  let hasTimestamp = false;
  if (s[j].cls === 2 && s[j].tag === 0) {
    const attrs = s[j++];
    // The signature covers the attributes encoded as a SET (tag 0x31), not [0].
    signedAttrs = A.whole(buf, attrs).slice();
    signedAttrs[0] = 0x31;
    for (const a of attrs.kids) {
      const id = A.oid(buf, a.kids[0]);
      const v = a.kids[1]?.kids[0];
      if (!v) continue;
      if (id === OID.messageDigest) messageDigest = A.content(buf, v).slice();
      if (id === OID.signingTime) signingTime = A.time(buf, v);
    }
  }
  const algN = s[j++];
  const sigAlg = A.oid(buf, algN.kids[0]);
  const signature = A.octets(buf, s[j++]);
  for (; j < s.length; j++)
    if (s[j].cls === 2 && s[j].tag === 1) for (const a of s[j].kids) if (A.oid(buf, a.kids[0]) === OID.timeStampToken) hasTimestamp = true;

  // Find the signer's certificate: issuer + serial number, or subject key id.
  let signer: Cert | null = null;
  if (sid.cls === 0 && sid.tag === A.TAG.SEQ) {
    const iss = A.whole(buf, sid.kids[0]);
    const ser = A.content(buf, sid.kids[1]);
    signer = certs.find((c) => A.equalBytes(c.issuerDer, iss) && A.equalBytes(c.serial, ser)) ?? null;
  } else if (sid.cls === 2 && sid.tag === 0) {
    const id = A.content(buf, sid);
    signer = certs.find((c) => c.ski && A.equalBytes(c.ski, id)) ?? null;
  }
  return { certs, signer, digestAlg, signedAttrs, messageDigest, signingTime, sigAlg, sigAlgParams: algN.kids[1] ?? null, signature, econtentType, econtent, buf, hasTimestamp };
}

/** messageImprint hash of an RFC 3161 TSTInfo. */
function tstImprint(t: Uint8Array): { hash: string; value: Uint8Array; time: Date | null } | null {
  try {
    const n = A.parse(t);
    const mi = n.kids[2];
    return { hash: HASH_OIDS[A.oid(t, mi.kids[0].kids[0])] ?? '', value: A.content(t, mi.kids[1]).slice(), time: A.time(t, n.kids[4]) };
  } catch {
    return null;
  }
}

/** Links certificates from the signer up to the last one the file contains, checking each link. */
async function buildChain(buf: Uint8Array, signer: Cert, certs: Cert[]): Promise<{ chain: Cert[]; broken: boolean }> {
  const chain = [signer];
  let broken = false;
  let cur = signer;
  for (let guard = 0; guard < 8; guard++) {
    if (cur.info.selfSigned) {
      if (!(await verifyWith(cur, cur.sigAlg, { buf, node: cur.sigAlgParams }, 'SHA-256', cur.sig, cur.tbs))) broken = true;
      break;
    }
    const up = certs.find((c) => c !== cur && A.equalBytes(c.subjectDer, cur.issuerDer) && !chain.includes(c));
    if (!up) break;
    if (!(await verifyWith(up, cur.sigAlg, { buf, node: cur.sigAlgParams }, 'SHA-256', cur.sig, cur.tbs))) broken = true;
    chain.push(up);
    cur = up;
  }
  return { chain, broken };
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

async function checkOne(bytes: Uint8Array, raw: RawSig, index: number): Promise<SignatureReport> {
  const rep: SignatureReport = {
    index,
    status: 'unknown',
    summary: '',
    notes: [],
    signer: 'Unknown signer',
    signerCert: null,
    chain: [],
    reason: raw.reason,
    time: pdfDate(raw.time),
    subFilter: raw.subFilter,
    timestamp: raw.subFilter === 'ETSI.RFC3161',
    coversAll: false,
    coveredBytes: 0,
    digest: '',
  };
  const r = raw.range;
  if (r.length !== 4 || r[0] !== 0 || r.some((v) => v < 0) || r[2] < r[1] || r[2] + r[3] > bytes.length) {
    rep.summary = 'This signature has a broken byte range, so it cannot be checked.';
    rep.status = 'invalid';
    return rep;
  }
  rep.coveredBytes = r[2] + r[3];
  rep.coversAll = rep.coveredBytes === bytes.length;
  if (raw.subFilter === 'adbe.x509.rsa_sha1') {
    rep.summary = 'This old signature format (adbe.x509.rsa_sha1) is not checked by Nib-E.';
    return rep;
  }
  let p: Parsed;
  try {
    p = parseCms(raw.contents);
  } catch (e) {
    rep.summary = `The signature data could not be read (${(e as Error).message}).`;
    rep.status = 'invalid';
    return rep;
  }
  rep.digest = p.digestAlg;
  if (p.signer) {
    rep.signerCert = p.signer.info;
    rep.signer = personName(p.signer.info.subject);
  }
  if (p.signingTime && !rep.time) rep.time = p.signingTime;
  if (!p.digestAlg) {
    rep.summary = 'The signature uses a hash method Nib-E does not know.';
    return rep;
  }
  if (!p.signer) {
    rep.summary = "The signer's certificate is not inside the file, so the signature cannot be checked.";
    return rep;
  }

  const parts = [bytes.subarray(r[0], r[0] + r[1]), bytes.subarray(r[2], r[2] + r[3])];
  // What the signature (or its attributes) says the document hash is.
  let expected: Uint8Array | null = null;
  let docHash: Uint8Array;
  if (p.econtentType === OID.tstInfo && p.econtent) {
    const imp = tstImprint(p.econtent);
    if (!imp || !imp.hash) {
      rep.summary = 'The timestamp could not be read.';
      rep.status = 'invalid';
      return rep;
    }
    rep.timestamp = true;
    if (imp.time) rep.time = imp.time;
    docHash = await digest(imp.hash, parts);
    expected = imp.value;
    if (!A.equalBytes(docHash, expected)) return failed(rep, 'The document was changed: its contents no longer match the timestamp.');
    // The timestamp authority signs the TSTInfo (via its attributes).
    const contentHash = await digest(p.digestAlg, [p.econtent]);
    if (p.messageDigest && !A.equalBytes(contentHash, p.messageDigest)) return failed(rep, 'The timestamp data does not match its own signature.');
  } else if (raw.subFilter === 'adbe.pkcs7.sha1' && p.econtent) {
    docHash = await digest('SHA-1', parts);
    if (!A.equalBytes(docHash, p.econtent)) return failed(rep, 'The document was changed: its contents no longer match the signature.');
    if (p.messageDigest && !A.equalBytes(await digest(p.digestAlg, [p.econtent]), p.messageDigest)) return failed(rep, 'The signature data does not match itself.');
  } else {
    docHash = await digest(p.digestAlg, parts);
    if (p.messageDigest && !A.equalBytes(docHash, p.messageDigest)) return failed(rep, 'The document was changed: its contents no longer match the signature.');
  }

  // The signature value itself.
  const signedData = p.signedAttrs ?? (p.econtent ?? null);
  let ok: boolean;
  if (signedData) ok = await verifyWith(p.signer, p.sigAlg, { buf: p.buf, node: p.sigAlgParams }, p.digestAlg, p.signature, signedData);
  else {
    // No attributes and no content: the signature is over the document bytes directly.
    const all = new Uint8Array(r[1] + r[3]);
    all.set(parts[0]);
    all.set(parts[1], r[1]);
    ok = await verifyWith(p.signer, p.sigAlg, { buf: p.buf, node: p.sigAlgParams }, p.digestAlg, p.signature, all);
  }
  if (!ok) return failed(rep, 'The signature does not match the certificate in it. It may be forged or damaged.');

  const { chain, broken } = await buildChain(p.buf, p.signer, p.certs);
  rep.chain = chain.map((c) => c.info);
  const c = p.signer.info;
  const when = rep.time ?? new Date();
  if (c.notAfter && when > c.notAfter) rep.notes.push(`The certificate expired on ${fmtDate(c.notAfter)}, before the signing time.`);
  if (c.notBefore && when < c.notBefore) rep.notes.push(`The certificate only became valid on ${fmtDate(c.notBefore)}, after the signing time.`);
  if (c.notAfter && c.notAfter < new Date() && !(when > c.notAfter)) rep.notes.push(`The certificate has expired since (${fmtDate(c.notAfter)}). That is normal for older signatures.`);
  if (broken) rep.notes.push('A certificate in the chain does not match its issuer.');
  const top = chain[chain.length - 1].info;
  if (c.selfSigned) rep.notes.push('The certificate is self-signed: anyone can make one with any name. Confirm with the person that it is really theirs.');
  else if (top.selfSigned) rep.notes.push(`Issued by "${personName(top.subject)}". Nib-E does not check whether that issuer is a trusted authority.`);
  else rep.notes.push(`Issued by "${personName(c.issuer)}". The issuer's certificate is not in the file.`);
  if (p.hasTimestamp) rep.notes.push('Includes a timestamp from a timestamp service.');
  rep.notes.push('Not checked: trust lists and revocation (needs the internet).');

  if (!rep.coversAll) {
    rep.status = 'changed';
    rep.summary = rep.timestamp
      ? 'The timestamp is intact for the version it covers. The file was changed or added to after that.'
      : 'Signed correctly, but the file was changed or added to after this signature.';
    rep.notes.unshift('Later changes can be harmless (another signature, form filling) or not. Compare with the signed version if it matters.');
  } else {
    rep.status = 'valid';
    rep.summary = rep.timestamp ? 'The timestamp is intact: the file has not changed since.' : 'Signature intact: the file has not changed since it was signed.';
  }
  if (broken && rep.status === 'valid') rep.status = 'changed';
  return rep;
}

function failed(rep: SignatureReport, why: string): SignatureReport {
  rep.status = 'invalid';
  rep.summary = why;
  return rep;
}

/** Checks every signature in a file (the bytes as they were opened). */
export async function checkSignatures(bytes: Uint8Array, password = ''): Promise<SignatureReport[]> {
  const raws = rawSignatures(bytes, password);
  const out: SignatureReport[] = [];
  for (let i = 0; i < raws.length; i++) {
    try {
      out.push(await checkOne(bytes, raws[i], i));
    } catch (e) {
      out.push({
        index: i,
        status: 'invalid',
        summary: `The signature could not be checked (${(e as Error).message}).`,
        notes: [],
        signer: 'Unknown signer',
        signerCert: null,
        chain: [],
        reason: raws[i].reason,
        time: pdfDate(raws[i].time),
        subFilter: raws[i].subFilter,
        timestamp: false,
        coversAll: false,
        coveredBytes: 0,
        digest: '',
      });
    }
  }
  // Say so when the later change is simply another signature.
  for (const r of out)
    if (r.status === 'changed' && out.some((o) => o !== r && o.coveredBytes > r.coveredBytes && o.status !== 'invalid'))
      r.notes.unshift('A later signature was added after this one, which also changes the file.');
  return out;
}

export { seq as derSeq };
