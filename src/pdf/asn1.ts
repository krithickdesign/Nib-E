// A small DER/BER reader: just enough of ASN.1 to check PDF signatures
// (CMS SignedData and X.509 certificates). Read-only, no dependencies.

export interface Node {
  /** Tag number (low 5 bits, or the long form value). */
  tag: number;
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  cons: boolean;
  /** Offset of the first header byte. */
  start: number;
  /** Offset of the content. */
  body: number;
  /** Offset just after the content (and its end-of-contents marker for BER). */
  end: number;
  /** Content length (for indefinite BER lengths: up to the end-of-contents marker). */
  len: number;
  kids: Node[];
}

const MAX_DEPTH = 40;

export class AsnError extends Error {}

export function parse(buf: Uint8Array, off = 0, limit = buf.length, depth = 0): Node {
  if (depth > MAX_DEPTH) throw new AsnError('Too deeply nested');
  if (off + 2 > limit) throw new AsnError('Truncated');
  const start = off;
  const b0 = buf[off++];
  const cls = b0 >> 6;
  const cons = (b0 & 0x20) !== 0;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b: number;
    let n = 0;
    do {
      if (off >= limit || ++n > 4) throw new AsnError('Bad tag');
      b = buf[off++];
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (off >= limit) throw new AsnError('Truncated');
  let len = buf[off++];
  let indefinite = false;
  if (len === 0x80) {
    if (!cons) throw new AsnError('Indefinite primitive');
    indefinite = true;
    len = 0;
  } else if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new AsnError('Length too long');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (off >= limit) throw new AsnError('Truncated');
      len = len * 256 + buf[off++];
    }
  }
  const body = off;
  const kids: Node[] = [];
  if (indefinite) {
    let p = body;
    for (;;) {
      if (p + 2 > limit) throw new AsnError('Missing end of contents');
      if (buf[p] === 0 && buf[p + 1] === 0) break;
      const k = parse(buf, p, limit, depth + 1);
      kids.push(k);
      p = k.end;
    }
    return { tag, cls, cons, start, body, end: p + 2, len: p - body, kids };
  }
  const end = body + len;
  if (end > limit) throw new AsnError('Truncated content');
  if (cons) {
    let p = body;
    while (p < end) {
      const k = parse(buf, p, end, depth + 1);
      kids.push(k);
      p = k.end;
    }
  }
  return { tag, cls, cons, start, body, end, len, kids };
}

export const TAG = { INT: 2, BIT: 3, OCTET: 4, NULL: 5, OID: 6, UTF8: 12, SEQ: 16, SET: 17, PRINT: 19, T61: 20, IA5: 22, UTC: 23, GEN: 24, BMP: 30 };

export function content(buf: Uint8Array, n: Node): Uint8Array {
  return buf.subarray(n.body, n.body + n.len);
}

/** The whole element (header and content) as it appears in the file. */
export function whole(buf: Uint8Array, n: Node): Uint8Array {
  return buf.subarray(n.start, n.end);
}

export function oid(buf: Uint8Array, n: Node): string {
  const b = content(buf, n);
  if (!b.length) return '';
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

/** Octet string contents; constructed (BER) octet strings are joined. */
export function octets(buf: Uint8Array, n: Node): Uint8Array {
  if (!n.cons) return content(buf, n).slice();
  const parts = n.kids.map((k) => octets(buf, k));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function text(buf: Uint8Array, n: Node): string {
  const b = content(buf, n);
  if (n.tag === TAG.BMP) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (n.tag === TAG.UTF8) return new TextDecoder().decode(b);
  return String.fromCharCode(...b);
}

/** UTCTime or GeneralizedTime. */
export function time(buf: Uint8Array, n: Node): Date | null {
  const s = text(buf, n);
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (m[1].length === 2) y += y < 50 ? 2000 : 1900;
  let ms = Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (m[7] && m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    ms -= sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5))) * 60000;
  }
  return new Date(ms);
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const NAME_KEYS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.5': 'serialNumber',
  '2.5.4.4': 'SN',
  '2.5.4.42': 'GN',
  '1.2.840.113549.1.9.1': 'E',
};

/** An X.501 name as a key → value map (first value of each kind). */
export function name(buf: Uint8Array, n: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of n.kids)
    for (const atv of set.kids) {
      if (atv.kids.length < 2) continue;
      const key = NAME_KEYS[oid(buf, atv.kids[0])];
      if (key && !(key in out)) out[key] = text(buf, atv.kids[1]);
    }
  return out;
}
