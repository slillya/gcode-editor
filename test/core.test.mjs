import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../src/gcode-core.js');
const Sample = require('../src/sample.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder('latin1').decode(b);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// Runs the whole edit pipeline and returns everything a test needs.
function edit(src, opts = {}) {
  const P = Core.parse(typeof src === 'string' ? enc(src) : src);
  const safeZ = 'safeZ' in opts ? opts.safeZ : Core.detectSafeZ(P).z;
  const cls = Core.classify(P, safeZ);
  const plan = Core.planEdits(P, cls, {
    airFeed: opts.airFeed ?? 5000,
    includeRetracts: opts.includeRetracts ?? true,
    feedMap: opts.feedMap ?? {},
  });
  const out = Core.buildOutput(P.bytes, plan.edits);
  const check = Core.verify(P, out, plan);
  return { P, cls, plan, out, check, text: dec(out), safeZ };
}

// Removes the F word from each line so edited and original lines can be compared.
const stripF = (line) => line.replace(/\s?F\s*[-+]?(\d+\.?\d*|\.\d+)/gi, '');

test('reads words with and without spaces, comments and block delete', () => {
  const P = Core.parse(enc('%\nN10 G90 G21 (setup)\ng1x10.5y-.25f1000. ; move\n/G1 X20\nG1 X 30 Y 1\n%\n'));
  const mv = P.moves;
  assert.equal(mv.n, 3);
  close(mv.x1[0], 10.5); close(mv.y1[0], -0.25); close(mv.feed[0], 1000);
  close(mv.x1[1], 20);
  close(mv.x1[2], 30); close(mv.y1[2], 1);
  assert.equal(P.lineSpace[2], 0);
  assert.equal(P.lineSpace[4], 1);
});

test('arc geometry: IJK, R format, full circles and helix length', () => {
  const P = Core.parse(enc('G17 G90 G21\nG0 X0 Y0 Z0\nG2 X10 Y0 I5 J0 F100\nG3 X0 Y0 R5\nG2 I5 J0\nG3 X0 Y0 Z-3 I5 J0\n'));
  const mv = P.moves;
  close(mv.len[1], 5 * Math.PI, 1e-9);
  close(mv.len[2], 5 * Math.PI, 1e-9);
  close(mv.len[3], 10 * Math.PI, 1e-9);
  close(mv.len[4], Math.hypot(10 * Math.PI, 3), 1e-9);
  // G2 from (0,0) to (10,0) around (5,0) passes through (5,5)
  const mid = Core.pointAt(P, 1, 0.5);
  close(mid[0], 5, 1e-9); close(mid[1], 5, 1e-9);
  // G3 R5 from (10,0) back to (0,0) is counter-clockwise, so it also passes over the top
  const mid2 = Core.pointAt(P, 2, 0.5);
  close(mid2[0], 5, 1e-9); close(mid2[1], 5, 1e-9);
});

test('G18 arcs follow the right-hand rule and bound Z exactly', () => {
  const P = Core.parse(enc('G18 G90 G21\nG0 X0 Y0 Z0\nG2 X10 Z0 I5 K0 F100\n'));
  const m = 1;
  const mid = Core.pointAt(P, m, 0.5);
  close(mid[0], 5, 1e-9); close(mid[2], -5, 1e-9);
  close(P.moves.zmin[m], -5, 1e-9);
});

test('inch programs display in inches and convert the air feed', () => {
  const src = 'G20 G90\nG1 X1 Y1 Z0.5 F20\nG1 Z0.2\nG1 Z-0.1 F5\nG1 X2\nG1 Z0.5 F20\nG1 X3\n';
  const r = edit(src, { safeZ: 0.2, airFeed: 200 });
  assert.equal(r.P.inch, true);
  assert.ok(r.check.ok);
  assert.match(r.text, /G1 Z0\.2 F200\n/);
  assert.match(r.text, /G1 Z-0\.1 F5\n/);
  assert.match(r.text, /G1 Z0\.5 F200\n/);
});

test('mixed units: millimetre blocks in an inch program get a converted feed', () => {
  const src = 'G20 G90\nG1 X0 Y0 Z1 F20\nG1 X1\nG21\nG1 X50\nG1 Z-1 F100\nG1 X60\n';
  const r = edit(src, { safeZ: 0.5, airFeed: 100 });
  assert.ok(r.check.ok);
  // 100 in/min in a G21 block is 2540 mm/min
  assert.match(r.text, /G1 X50 F2540\n/);
});

test('the sample is detected, edited and verified identical', () => {
  const r = edit(Sample.make());
  assert.equal(r.safeZ, 2);
  assert.ok(r.check.ok, JSON.stringify(r.check));
  assert.equal(r.check.geometry, 0);
  assert.equal(r.check.bytes, 0);
  assert.ok(r.plan.edits.length > 20);
  const a = Sample.make().split('\n'), b = r.text.split('\n');
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.equal(stripF(a[i]), stripF(b[i]), `line ${i + 1} changed more than its F word`);
  }
});

test('running the tool on its own output changes nothing more', () => {
  const first = edit(Sample.make());
  const second = edit(first.out, { safeZ: first.safeZ });
  assert.equal(second.plan.edits.length, 0);
});

test('cutting moves keep their feed; only air moves change', () => {
  const r = edit(Sample.make());
  const mv = r.P.moves;
  for (let i = 0; i < mv.n; i++) {
    if (mv.kind[i] === Core.KIND.RAPID) continue;
    const sped = Core.isSpedUp(r.P, r.cls, i, true);
    if (sped) close(r.plan.moveFeed[i], 5000);
    else close(r.plan.moveFeed[i], mv.feed[i]);
  }
});

test('CRLF line endings and non-UTF-8 bytes survive untouched', () => {
  const head = enc('(PLATE Ø6 MM)\r\nG90 G21\r\n');
  const latin = new Uint8Array([0x28, 0x44, 0xb0, 0x29, 0x0d, 0x0a]); // "(D°)" in Latin-1
  const body = enc('G1 X0 Y0 Z10 F800\r\nG1 X50\r\nG1 Z-1 F200\r\nG1 X60 F800\r\nG1 Z10\r\nG1 X0\r\n');
  const bytes = new Uint8Array([...head, ...latin, ...body]);
  const r = edit(bytes, { safeZ: 5 });
  assert.ok(r.check.ok);
  const out = r.out;
  assert.deepEqual([...out.slice(0, head.length + latin.length)], [...bytes.slice(0, head.length + latin.length)]);
  assert.equal(dec(out).split('\r\n').length, dec(bytes).split('\r\n').length);
  assert.ok(!/[^\r]\n/.test(dec(out)), 'every newline is still CRLF');
});

test('replaced and inserted F words follow the file number style', () => {
  const src = 'G90 G21\nG1 X0 Y0 Z10. F800.\nG1 X50.\nG1 Z-1. F200.\nG1 X60. F800.\nG1 Z10.\nG1 X0.\n';
  const r = edit(src, { safeZ: 5 });
  assert.ok(r.check.ok);
  assert.match(r.text, /G1 X50\. F5000\.\n/);
  assert.match(r.text, /G1 Z10\. F5000\.\n/);
});

test('words without spaces get an F word without a space', () => {
  const r = edit('G90G21\nG1X0Y0Z10F800\nG1X50\nG1Z-1F200\nG1X60F800\nG1Z10\nG1X0\n', { safeZ: 5 });
  assert.ok(r.check.ok);
  assert.match(r.text, /G1Z10F5000\n/);
});

test('an F word goes before a trailing comment', () => {
  const r = edit('G90 G21\nG1 X0 Y0 Z10 F800\nG1 Z-1 F200\nG1 X5 F800\nG1 Z10 (retract)\n', { safeZ: 5 });
  assert.ok(r.check.ok);
  assert.match(r.text, /G1 Z10 F5000 \(retract\)\n/);
});

test('inverse-time blocks are left alone', () => {
  const src = 'G90 G21\nG1 X0 Y0 Z10 F800\nG93 G1 X10 F50\nG1 X20 F60\nG94 G1 X30 F800\nG1 Z-1\nG1 X40\n';
  const r = edit(src, { safeZ: 5 });
  assert.ok(r.check.ok);
  assert.match(r.text, /G93 G1 X10 F50\n/);
  assert.match(r.text, /G1 X20 F60\n/);
});

test('canned cycles are drawn and their feed can be remapped', () => {
  const src = 'G90 G21\nG0 X0 Y0 Z20\nG98 G81 X10 Y10 Z-5 R2 F150\nX20\nG80\nG0 Z20\n';
  const P = Core.parse(enc(src));
  const mv = P.moves;
  const feedMoves = [];
  for (let i = 0; i < mv.n; i++) if (mv.kind[i] === Core.KIND.LINE) feedMoves.push(i);
  assert.equal(feedMoves.length, 2);
  close(mv.z0[feedMoves[0]], 2); close(mv.z1[feedMoves[0]], -5);
  const r = edit(src, { feedMap: { [Core.feedKey(150, 94, 0)]: 180 } });
  assert.ok(r.check.ok);
  assert.match(r.text, /G98 G81 X10 Y10 Z-5 R2 F180\n/);
});

test('peck re-entries into an already drilled hole count as air moves', () => {
  const src = 'G90 G21\nG1 X0 Y0 Z10 F200\nG1 Z2\nG1 Z-4\nG1 Z2\nG1 Z-3.5\nG1 Z-8\nG1 Z2\n';
  const P = Core.parse(enc(src));
  const cls = Core.classify(P, 2);
  // moves: [0] positioning, [1] 10->2, [2] 2->-4, [3] -4->2, [4] 2->-3.5, [5] -3.5->-8, [6] -8->2
  assert.equal(cls[2], Core.CLS.PLUNGE);
  assert.equal(cls[3], Core.CLS.RETRACT);
  assert.equal(cls[4], Core.CLS.AIR);
  assert.equal(cls[5], Core.CLS.PLUNGE);
});

test('moves from an unknown start position keep their feed', () => {
  const r = edit('G90 G21\nG1 X10 Y10 F300\nG1 Z10\nG1 Z2\nG1 Z-1\nG1 X20\nG1 Z10\n', { safeZ: 2 });
  assert.ok(r.check.ok);
  assert.match(r.text, /^G90 G21\nG1 X10 Y10 F300\n/);
});

test('probing moves are never sped up', () => {
  const r = edit('G90 G21\nG0 X0 Y0 Z20\nG38.2 Z5 F100\nG1 X10 F100\n', { safeZ: 2 });
  assert.ok(r.check.ok);
  assert.match(r.text, /G38\.2 Z5 F100\n/);
});

test('safe height detection', () => {
  const g0 = 'G90 G21\nG0 X0 Y0 Z15\nG0 Z5\nG1 Z-2 F300\nG1 X20 F1000\nG0 Z15\nG0 X40\nG0 Z5\nG1 Z-2 F300\nG1 X60 F1000\nG0 Z15\n';
  assert.equal(Core.detectSafeZ(Core.parse(enc(g0))).z, 5);
  const flat = 'G90 G21\nG1 X0 Y0 F100\nG1 X10\nG1 Y10\n';
  assert.equal(Core.detectSafeZ(Core.parse(enc(flat))).z, null);
  const flatZ0 = 'G90 G21\nG1 X0 Y0 Z0 F100\nG1 X10\nG1 Y10\nG1 X0\n';
  assert.equal(Core.detectSafeZ(Core.parse(enc(flatZ0))).z, null);
  const laser = 'G90 G21\nG0 X0 Y0 Z0\nG1 X10 F800\nG0 X20\nG1 X30\n';
  assert.equal(Core.detectSafeZ(Core.parse(enc(laser))).z, null);
});

test('without a safe height only re-entries count as air moves', () => {
  const r = edit(Sample.make(), { safeZ: null });
  assert.ok(r.check.ok);
  const mv = r.P.moves;
  for (let i = 0; i < mv.n; i++) {
    if (r.cls[i] !== Core.CLS.AIR) continue;
    assert.ok(mv.z1[i] < mv.z0[i] && mv.x0[i] === mv.x1[i] && mv.y0[i] === mv.y1[i], `move ${i} is not a straight re-entry`);
  }
});

test('with no air feed nothing is changed', () => {
  const r = edit(Sample.make(), { airFeed: 0 });
  assert.ok(r.check.ok);
  assert.equal(r.plan.edits.length, 0);
  assert.deepEqual([...r.out], [...enc(Sample.make())]);
});

test('a tab crossing in a single-pass contour is never taken for a traverse', () => {
  const src = [
    'G90 G21',
    'G1 X0 Y0 F1000', 'G1 Z15', 'G1 Z5', 'G1 Z2', 'G1 Z-3 F300',
    'G1 X40 F1000', 'G1 Z-2.5', 'G1 X50', 'G1 Z-3', 'G1 X100', 'G1 Y30', 'G1 X0', 'G1 Y0',
    'G1 Z15', 'G1 X200', ''
  ].join('\n');
  const P = Core.parse(enc(src));
  const det = Core.detectSafeZ(P);
  assert.equal(det.z, 2);
  const cls = Core.classify(P, det.z);
  const tab = P.lineMove[8]; // G1 X50 at Z-2.5 across the tab
  assert.equal(P.moves.line[tab], 8);
  assert.equal(cls[tab], Core.CLS.CUT);
});

test('shallow plunges keep the safe height above them', () => {
  const src = [
    'G90 G21', 'G1 X0 Y0 F200', 'G1 Z15', 'G1 X10', 'G1 Z5', 'G1 Z2', 'G1 Z-3.5', 'G1 Z-8', 'G1 Z15',
    'G1 X30', 'G1 Z5', 'G1 Z-1', 'G1 Z15', ''
  ].join('\n');
  const det = Core.detectSafeZ(Core.parse(enc(src)));
  assert.ok(det.z > -1, `safe height ${det.z} is below a plunge that cuts to Z-1`);
});

test('verification catches a tampered file', () => {
  const r = edit(Sample.make());
  const bad = r.out.slice();
  const i = dec(bad).indexOf('X128');
  bad[i + 1] = '2'.charCodeAt(0);
  assert.equal(Core.verify(r.P, bad, r.plan).ok, false);
});

test('the inch demo is written in G20 and edits cleanly', () => {
  const text = Sample.make({ inch: true });
  assert.match(text, /^G20$/m);
  assert.ok(!/[XYZIJF]-?\d+\.\d{5,}/.test(text), 'no more than 4 decimals');
  const r = edit(text, { airFeed: 200 });
  assert.equal(r.P.fileUnits, 'inch');
  close(r.safeZ, 0.08);
  assert.ok(r.check.ok);
  assert.match(r.text, /G1 Z0\.2 F200\n/);
  assert.equal(edit(r.out, { safeZ: r.safeZ, airFeed: 200 }).plan.edits.length, 0);
});

test('a millimetre file shown in inches keeps millimetre feeds in the output', () => {
  const P = Core.parse(enc(Sample.make()), { inch: true });
  assert.equal(P.inch, true);
  assert.equal(P.fileUnits, 'mm');
  close(P.bbox.maxZ, 15 / 25.4, 1e-12);
  const det = Core.detectSafeZ(P);
  close(det.z, 2 / 25.4, 1e-12);
  const cls = Core.classify(P, det.z);
  const plan = Core.planEdits(P, cls, { airFeed: 200, includeRetracts: true, feedMap: {} });
  const out = Core.buildOutput(P.bytes, plan.edits);
  assert.ok(Core.verify(P, out, plan).ok);
  // 200 in/min is written as 5080 mm/min in a G21 file
  assert.ok(plan.edits.every((e) => e.to === 5080 || e.insert));
  assert.match(dec(out), /G1 Z15 F5080\n/);
  // and the edit plan matches the one made with millimetre display
  const Pm = Core.parse(enc(Sample.make()));
  const planMm = Core.planEdits(Pm, Core.classify(Pm, Core.detectSafeZ(Pm).z), { airFeed: 5080, includeRetracts: true, feedMap: {} });
  assert.deepEqual(plan.edits.map((e) => [e.line, e.text]), planMm.edits.map((e) => [e.line, e.text]));
});

test('file units are reported separately from display units', () => {
  assert.equal(Core.parse(enc('G21\nG1 X1 F100\n'), { inch: true }).fileUnits, 'mm');
  assert.equal(Core.parse(enc('G20\nG1 X1 F10\nG21\nG1 X2\n')).fileUnits, 'mixed');
  assert.equal(Core.parse(enc('G1 X1 F100\n')).fileUnits, null);
});
