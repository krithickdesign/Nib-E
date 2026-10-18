// Signing and signature checks without a browser: npx tsx test/signatures.ts
// Signs a fixture with the test-only certificate, then checks the result, a
// tampered copy, a copy with bytes added, and a file signed twice by another tool.
import { readFileSync } from 'node:fs';
import { init } from '@embedpdf/pdfium';
import { setPdfium } from '../src/pdf/core';
import { signPdf, inspectP12 } from '../src/pdf/sign';
import { checkSignatures } from '../src/pdf/signatures';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const m = await init({ wasmBinary: readFileSync(new URL('../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)) } as never);
m.PDFiumExt_Init();
setPdfium(m);

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
};

const p12 = fx('test-only-cert.p12');
const who = await inspectP12(p12, 'test');
check('reads the test certificate', who.name === 'Nib-E Test Signer' && who.selfSigned);
let wrong = '';
await inspectP12(p12, 'nope').catch((e: Error) => (wrong = e.message));
check('wrong password is reported clearly', /Wrong password/.test(wrong), wrong);

const signed = await signPdf(fx('retype.pdf'), { p12, password: 'test', reason: 'Test – für März', page: 0, rect: { x: 330, y: 700, w: 220, h: 58 } });
let r = await checkSignatures(signed);
check('own signature is intact', r.length === 1 && r[0].status === 'valid' && r[0].signer === 'Nib-E Test Signer', r[0]?.summary);
check('reason survives (Unicode)', r[0]?.reason === 'Test – für März', r[0]?.reason);

const bad = signed.slice();
const at = Buffer.from(bad).indexOf('/MediaBox');
bad[at + 13] = bad[at + 13] === 0x31 ? 0x32 : 0x31;
r = await checkSignatures(bad);
check('a changed byte makes it not valid', r[0]?.status === 'invalid', r[0]?.summary);

r = await checkSignatures(new Uint8Array([...signed, ...Buffer.from('\n% added\n')]));
check('bytes added after signing: changed after', r[0]?.status === 'changed', r[0]?.summary);

r = await checkSignatures(fx('signed.pdf'));
check('file signed twice by another tool: first changed, second intact', r.map((x) => x.status).join(',') === 'changed,valid', r.map((x) => x.status).join(','));
check('...the first one says a later signature was added', /later signature/.test(r[0]?.notes.join(' ') ?? ''));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
