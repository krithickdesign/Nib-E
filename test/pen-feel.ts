// Pen feel check: simulated handwriting through each feel preset.
// Run: npx tsx test/pen-feel.ts
// Measures how far the drawn line strays from what the hand did (lag and
// corner rounding) and how much sensor jitter is left. Exits 1 on regression.
import { getStrokePoints } from 'perfect-freehand';
import { FEELS, outline, Smoother, type PenFeel } from '../src/ink/stroke';

type P = [number, number];

/** A handwriting-like path: loops (cursive "l e"), then sharp zigzag corners ("z", "k"). Screen px. */
function truthPath(hz: number): { t: number; p: P }[] {
  const out: { t: number; p: P }[] = [];
  let t = 0;
  const push = (p: P) => {
    out.push({ t, p });
    t += 1000 / hz;
  };
  // Two cursive loops, letter height ~24 px, ~1.2 s.
  const n = Math.round((290 * hz) / 240);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 4;
    push([40 + (i / n) * 101 + 9 * Math.sin(a), 100 - 12 - 12 * Math.cos(a)]);
  }
  // Zigzag with hard corners: 4 segments of 22 px at ~110 px/s.
  const corners: P[] = [[150, 80], [172, 80], [150, 104], [172, 104], [150, 80]];
  for (let s = 0; s < corners.length - 1; s++) {
    const [a, b] = [corners[s], corners[s + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.round((len / 110) * hz);
    for (let i = 0; i < steps; i++) push([a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]);
  }
  push(corners[corners.length - 1]);
  return out;
}

// Deterministic noise (sensor jitter ~0.35 px).
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function run(feel: PenFeel, pen: boolean) {
  const hz = pen ? 240 : 60; // stylus digitizer vs mouse/trackpad/finger
  const truth = truthPath(hz);
  const sm = new Smoother(pen, feel);
  const filtered: P[] = truth.map(({ t, p }) => {
    const [x, y] = sm.push(p[0] + rnd() * 0.35, p[1] + rnd() * 0.35, 0.5, t);
    return [x, y];
  });
  // Lag: distance between where the line is drawn and where the pen is now.
  const lag = filtered.map((f, i) => Math.hypot(f[0] - truth[i].p[0], f[1] - truth[i].p[1]));
  const meanLag = lag.reduce((a, b) => a + b, 0) / lag.length;
  // Corner rounding on the final centre line (filter + streamline), as drawn.
  const drawn: P[] = getStrokePoints(filtered.map(([x, y]) => [x, y, 0.5]), { streamline: FEELS[feel].streamline, size: 2, last: true }).map((sp) => sp.point as P);
  const corners: P[] = [[172, 80], [150, 104], [172, 104]];
  const cornerMiss = Math.max(...corners.map((c) => Math.min(...drawn.map((f) => Math.hypot(f[0] - c[0], f[1] - c[1])))));
  // Jitter left: second difference on the slow loop part.
  let jit = 0;
  const loopN = Math.round((290 * hz) / 240);
  for (let i = 2; i < loopN; i++) jit += Math.hypot(filtered[i][0] - 2 * filtered[i - 1][0] + filtered[i - 2][0], filtered[i][1] - 2 * filtered[i - 1][1] + filtered[i - 2][1]);
  jit /= loopN - 2;
  // Outline still builds.
  const ol = outline({ kind: 'pen', size: 2, sim: false, feel, pts: filtered.map(([x, y]) => [x, y, 0.5]) });
  return { input: pen ? 'stylus 240 Hz' : 'mouse/finger 60 Hz', feel, meanLag, cornerMiss, jitter: jit, outlinePts: ol.length, streamline: FEELS[feel].streamline };
}

const feels: PenFeel[] = ['precise', 'balanced', 'smooth'];
let ok = true;
for (const pen of [true, false]) {
  const rows = feels.map((f) => run(f, pen));
  console.table(rows.map((r) => ({ ...r, meanLag: r.meanLag.toFixed(2), cornerMiss: r.cornerMiss.toFixed(2), jitter: r.jitter.toFixed(3) })));
  const [p, b, s] = rows;
  ok &&= p.meanLag < b.meanLag && b.meanLag < s.meanLag;
  ok &&= p.cornerMiss < b.cornerMiss && b.cornerMiss < s.cornerMiss * 0.75;
  ok &&= b.jitter <= p.jitter + 0.01 && rows.every((r) => r.outlinePts > 10);
}
console.log(ok ? 'PASS pen feel ordering (precise < balanced < smooth lag; balanced keeps corners)' : 'FAIL pen feel');
process.exit(ok ? 0 : 1);
