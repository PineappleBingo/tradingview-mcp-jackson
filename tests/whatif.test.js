/**
 * Counterfactual replay (src/core/whatif.js) — pure, no TradingView, hand-computed fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, replay, METRIC_NAMES } from '../src/core/whatif.js';

// Six pattern bars. Values chosen so every assertion below is checkable by eye.
// er / roomPct / reqPct are the three the report's recommendations actually reach for.
const bar = (o) => ({
  t: Date.parse(o.iso), iso: o.iso, side: o.side || 'L', reason: o.reason == null ? 8 : o.reason,
  reasonName: 'Healthy Breakout + FVG', fired: !!o.fired, live: false,
  blocker: o.blocker || null, blockerCode: o.blocker ? o.blocker.slice(0, -1) : null,
  sideFailedGates: o.failed || [],
  metrics: {
    er: o.er ?? null, roomPct: o.room ?? null, reqPct: o.req ?? null, targetRoomAtr: o.atr ?? null,
    macro: o.macro ?? 1, volGate: o.vol ?? 0, dshapeState: null, dshapeRotation: null, supertrend: null,
    regime: o.regime === undefined ? { raw: 0, active: false, evidence: 0, whipsaw: 0 } : o.regime,
  },
});

// The 16:30 long from the 2026-09-08 entry review: room 0.758 against req 1.5.
const VERDICTS = [
  bar({ iso: '2026-09-08T15:45:00.000Z', fired: true, er: 0.357, room: 0.767, req: 1.5, vol: 1 }),
  bar({ iso: '2026-09-08T16:30:00.000Z', fired: true, er: 0.271, room: 0.758, req: 1.5, vol: 0 }),
  bar({ iso: '2026-09-08T17:00:00.000Z', fired: true, er: 0.500, room: 2.100, req: 1.5, vol: 1 }),
  bar({ iso: '2026-09-08T17:15:00.000Z', fired: true, er: 0.410, room: 1.900, req: 1.5, vol: 1 }),
  bar({ iso: '2026-09-08T17:30:00.000Z', fired: true, er: 0.380, room: 1.600, req: 1.5, vol: 1 }),
  bar({ iso: '2026-09-08T17:45:00.000Z', er: 0.230, room: 0.241, req: 1.5, blocker: 'PrxL', failed: ['PrxL'] }),
  bar({ iso: '2026-09-08T18:00:00.000Z', er: 0.189, room: 0.328, req: 1.5, blocker: 'RoomL', failed: ['RoomL'] }),
  bar({ iso: '2026-09-08T18:15:00.000Z', er: 0.200, room: 0.300, req: 1.5, blocker: 'RoomL', failed: ['RoomL', 'TrdL'] }),
];

test('require: flips exactly the fired bars that fail, leaves the rest alone', () => {
  // The report's rec #2: the ATR path must still satisfy roomPct >= reqPct * 0.7 (= 1.05).
  const r = replay(VERDICTS, {
    kind: 'require',
    pred: { metric: 'roomPct', op: 'gte', value: { metric: 'reqPct', mul: 0.7 } },
  }, { atIso: '2026-09-08T16:30' });

  assert.equal(r.valid, true);
  assert.equal(r.kind, 'require');
  assert.deepEqual(r.touched.sort(), ['reqPct', 'roomPct']);
  assert.equal(r.counts.fired.before, 5);
  assert.equal(r.counts.flipped, 2);              // 0.767 and 0.758 are both under 1.05
  assert.equal(r.counts.fired.after, 3);
  assert.deepEqual(r.flips.map((f) => f.iso), [
    '2026-09-08T15:45:00.000Z', '2026-09-08T16:30:00.000Z',
  ]);
  assert.deepEqual(r.flips[1].values, { roomPct: 0.758, reqPct: 1.5 }); // only touched metrics
  assert.equal(r.target.found, true);
  assert.equal(r.target.was, 'FIRED');
  assert.equal(r.target.now, 'BLOCKED');
  assert.equal(r.target.flipped, true);
  assert.equal(r.verdict, 'effective');
  assert.equal(r.window.bars, 8);
});

test('require: blocked bars are never touched, however the predicate falls on them', () => {
  // 17:00 passes, so a rule keyed on it must not resurrect the blocked bars that also pass.
  const r = replay(VERDICTS, { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.10 } });
  assert.equal(r.counts.flipped, 0);
  assert.equal(r.counts.fired.after, 5);   // unchanged — no bar was unblocked
  assert.equal(r.counts.unblocked, 0);
  assert.equal(r.verdict, 'no-effect');
});

test('gte is inclusive at the boundary', () => {
  const at = replay(VERDICTS, { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.271 } });
  assert.equal(at.counts.flipped, 0, '0.271 >= 0.271 must hold');
  const above = replay(VERDICTS, { kind: 'require', pred: { metric: 'er', op: 'gt', value: 0.271 } });
  assert.equal(above.counts.flipped, 1, 'gt at the same value excludes it');
});

test('all / any / not and between compose', () => {
  const all = replay(VERDICTS, {
    kind: 'require',
    pred: { all: [{ metric: 'er', op: 'gte', value: 0.30 }, { metric: 'volGate', op: 'eq', value: 1 }] },
  });
  assert.equal(all.counts.flipped, 1, 'only 16:30 fails both-ish (er 0.271, vol 0)');

  const any = replay(VERDICTS, {
    kind: 'require',
    pred: { any: [{ metric: 'er', op: 'gte', value: 0.40 }, { metric: 'roomPct', op: 'gte', value: 1.5 }] },
  });
  assert.deepEqual(any.flips.map((f) => f.iso), [
    '2026-09-08T15:45:00.000Z', '2026-09-08T16:30:00.000Z',
  ]);

  const not = replay(VERDICTS, { kind: 'require', pred: { not: { metric: 'volGate', op: 'eq', value: 0 } } });
  assert.equal(not.counts.flipped, 1, 'flips the one fired bar with volGate 0');

  const btw = replay(VERDICTS, { kind: 'require', pred: { metric: 'er', op: 'between', value: [0.30, 0.45] } });
  assert.deepEqual(btw.flips.map((f) => f.iso), [
    '2026-09-08T16:30:00.000Z', '2026-09-08T17:00:00.000Z',
  ]);
});

test('a null metric is unknown — never a flip, never a silent pass', () => {
  const rows = VERDICTS.map((v, i) => (i === 1 ? bar({ iso: v.iso, fired: true, er: null, room: 0.758, req: 1.5 }) : v));
  const r = replay(rows, { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.99 } });
  assert.equal(r.counts.unknown, 1);
  assert.deepEqual(r.unknownBars, ['2026-09-08T16:30:00.000Z']);
  assert.equal(r.counts.flipped, 4, 'the four readable fired bars flip; the null one does not');
  assert.ok(!r.flips.some((f) => f.iso === '2026-09-08T16:30:00.000Z'));
});

test('a right-hand metric that is null makes the whole leaf unknown', () => {
  const rows = [bar({ iso: '2026-09-08T16:30:00.000Z', fired: true, room: 0.758, req: null })];
  const r = replay(rows, {
    kind: 'require', pred: { metric: 'roomPct', op: 'gte', value: { metric: 'reqPct', mul: 0.7 } },
  });
  assert.equal(r.counts.unknown, 1);
  assert.equal(r.counts.flipped, 0);
});

test('three-valued logic: a definite failure in all/ beats unknown; unknown otherwise wins', () => {
  const rows = [bar({ iso: '2026-09-08T16:30:00.000Z', fired: true, er: null, room: 0.1, req: 1.5 })];
  const definite = replay(rows, {
    kind: 'require',
    pred: { all: [{ metric: 'er', op: 'gte', value: 0.3 }, { metric: 'roomPct', op: 'gte', value: 1.0 }] },
  });
  assert.equal(definite.counts.flipped, 1, 'roomPct definitely fails, so the unknown er cannot rescue it');
  assert.equal(definite.counts.unknown, 0);

  const unsure = replay(rows, {
    kind: 'require',
    pred: { all: [{ metric: 'er', op: 'gte', value: 0.3 }, { metric: 'roomPct', op: 'gte', value: 0.05 }] },
  });
  assert.equal(unsure.counts.unknown, 1, 'the readable half passes, so the unknown half decides');
  assert.equal(unsure.counts.flipped, 0);
});

test('relax unblocks only when every failed gate is covered', () => {
  const r = replay(VERDICTS, { kind: 'relax', gates: ['RoomL'] });
  assert.equal(r.kind, 'relax');
  assert.equal(r.counts.unblocked, 1, '18:15 also failed TrdL, so it stays blocked');
  assert.deepEqual(r.unblocks.map((u) => u.iso), ['2026-09-08T18:00:00.000Z']);
  assert.equal(r.counts.fired.before, 5);
  assert.equal(r.counts.fired.after, 6);
  assert.equal(r.counts.flipped, 0, 'relax never blocks anything');

  const both = replay(VERDICTS, { kind: 'relax', gates: ['RoomL', 'TrdL'] });
  assert.equal(both.counts.unblocked, 2, 'covering TrdL too releases 18:15');
});

test('malformed rules are refused with a reason, and nothing throws', () => {
  const bad = [
    [{ kind: 'require', pred: { metric: '__proto__', op: 'gte', value: 1 } }, /unknown metric/],
    [{ kind: 'require', pred: { metric: 'constructor', op: 'gte', value: 1 } }, /unknown metric/],
    [{ kind: 'require', pred: { metric: 'atr14', op: 'gte', value: 1 } }, /unknown metric/],
    [{ kind: 'require', pred: { metric: 'er', op: '=~', value: 1 } }, /unknown op/],
    [{ kind: 'require', pred: { metric: 'er', op: 'gte', value: NaN } }, /value must be/],
    [{ kind: 'require', pred: { metric: 'er', op: 'between', value: [1] } }, /between/],
    [{ kind: 'require', pred: { all: [] } }, /non-empty/],
    [{ kind: 'require', pred: {} }, /no metric/],
    [{ kind: 'relax', gates: [] }, /needs gates/],
    [{ kind: 'nope' }, /kind must be/],
    ['not an object', /must be an object/],
  ];
  for (const [rule, re] of bad) {
    const c = compileRule(rule);
    assert.equal(c.valid, false, `should refuse ${JSON.stringify(rule)}`);
    assert.match(c.reason, re);
    const r = replay(VERDICTS, rule);              // must not throw
    assert.equal(r.valid, false);
    assert.equal(r.verdict, 'invalid');
    assert.deepEqual(r.flips, []);
    assert.equal(r.counts, null);
  }
});

test('nesting and fan-out are capped', () => {
  const deep = { all: [{ all: [{ all: [{ all: [{ metric: 'er', op: 'gte', value: 1 }] }] }] }] };
  assert.match(compileRule({ kind: 'require', pred: deep }).reason, /nested deeper/);
  const wide = { any: Array.from({ length: 9 }, () => ({ metric: 'er', op: 'gte', value: 1 })) };
  assert.match(compileRule({ kind: 'require', pred: wide }).reason, /max 8/);
});

test('too few evaluable entries reads as insufficient, not as proof', () => {
  const two = VERDICTS.slice(0, 2);
  const r = replay(two, { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.99 } });
  assert.equal(r.counts.flipped, 2);
  assert.equal(r.verdict, 'insufficient', 'two entries cannot verify anything');
});

test('a rule unreadable on most bars is insufficient however the readable ones fell', () => {
  const rows = VERDICTS.map((v) => (v.fired ? { ...v, metrics: { ...v.metrics, er: null } } : v));
  rows[0] = bar({ iso: rows[0].iso, fired: true, er: 0.1, room: 1, req: 1 });
  const r = replay(rows, { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.99 } });
  assert.equal(r.counts.unknown, 4);
  assert.equal(r.counts.flipped, 1);
  assert.equal(r.verdict, 'insufficient');
});

test('atIso: a bar that does not flip, and a bar outside the window', () => {
  const rule = { kind: 'require', pred: { metric: 'er', op: 'gte', value: 0.30 } };
  const stays = replay(VERDICTS, rule, { atIso: '2026-09-08T17:00' });
  assert.equal(stays.target.found, true);
  assert.equal(stays.target.flipped, false);
  assert.equal(stays.target.now, 'FIRED');

  const gone = replay(VERDICTS, rule, { atIso: '2026-01-01T00:00' });
  assert.equal(gone.target.found, false);
  assert.equal(gone.target.flipped, false);
});

test('empty input produces zeroes, never NaN', () => {
  const r = replay([], { kind: 'require', pred: { metric: 'er', op: 'gte', value: 1 } });
  assert.equal(r.valid, true);
  assert.equal(r.counts.fired.before, 0);
  assert.equal(r.counts.fired.after, 0);
  assert.equal(r.verdict, 'insufficient');
  assert.deepEqual(r.window, { bars: 0, firstIso: null, lastIso: null });
  for (const v of [r.counts.flipped, r.counts.unblocked, r.counts.unknown, r.counts.patternBars]) {
    assert.ok(Number.isFinite(v) && !Number.isNaN(v));
  }
});

test('side, reason and hourUTC are addressable', () => {
  assert.ok(METRIC_NAMES.includes('side') && METRIC_NAMES.includes('hourUTC'));
  const r = replay(VERDICTS, { kind: 'require', pred: { metric: 'hourUTC', op: 'gte', value: 17 } });
  assert.deepEqual(r.flips.map((f) => f.iso), [
    '2026-09-08T15:45:00.000Z', '2026-09-08T16:30:00.000Z',
  ]);
  const s = replay(VERDICTS, { kind: 'require', pred: { metric: 'side', op: 'eq', value: 'S' } });
  assert.equal(s.counts.flipped, 5, 'every fired bar here is long, so a short-only rule blocks them all');
});
