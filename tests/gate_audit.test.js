/**
 * Unit tests for the gate-audit decoder (src/core/gateAudit.js).
 * Pure: no live TradingView needed. Masks are real values seen on PF 3G VP v4.4.1.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProfile, plotFilterFromProfile, resolveColumns, decodeMask, decodeRegime, pickBlocker, decodeGateAudit,
} from '../src/core/gateAudit.js';

const profile = loadProfile();
const P = 'PineForge 3rd Gen Volume Profile [Coinbase]::';
const COLUMNS = ['time',
  P + 'Audit Final Entry Pass Mask', P + 'Audit Long Execution Reason', P + 'Audit Short Execution Reason',
  P + 'Final Entry Trigger Long', P + 'Final Entry Trigger Short', P + 'Audit Efficiency Ratio',
  P + 'Audit Range Regime State', P + 'Audit Generic Room Percent', P + 'Audit Required Move Percent',
  P + 'Audit Confirmed Macro Shape', P + 'Audit Core Target Room ATR', P + 'Audit Entry Volume Gate'];
const T0 = 1787716800; // 2026-08-26T04:00:00Z
const bar = (i, mask, rL, rS, tL, tS, er, regime, room, req, macro, tgt, vol) => [T0 + i * 900, mask, rL, rS, tL, tS, er, regime, room, req, macro, tgt, vol];
// Bit arithmetic: 65021 = 65535-512-2 · 65397 = 65535-128-8-2 · 40831 = 65535-16384-8192-128
// 60799 = 65535-4096-512-128 · 65525 = 65535-8-2 · 53247 = 65535-8192-4096 · 62815 = 65535-2048-512-128-32
const ROWS = [
  bar(0, 65535, 0, 0, 0, 0, 0.31, 0,   1.2,  0.65, 0,  1.4, 1), // 1 no pattern
  bar(1, 65021, 8, 0, 0, 0, 0.44, 0,   0.42, 0.65, 1,  0.9, 1), // 2 L8 blocked RoomL
  bar(2, 65397, 0, 8, 0, 0, 0.39, 0,   0.30, 0.65, 0,  0.8, 1), // 3 S8 blocked RoomS
  bar(3, 40831, 8, 0, 0, 0, 0.18, 121, 1.1,  0.65, 0,  1.3, 1), // 4 L8 blocked RgmL
  bar(4, 60799, 8, 0, 0, 0, 0.41, 0,   1.3,  0.65, -1, 1.5, 1), // 5 L8 blocked MacL
  bar(5, 65525, 7, 0, 0, 0, 0.52, 0,   0.5,  0.65, 1,  1.0, 1), // 6 L7 blocked RoomL+TrdL → TrdL
  bar(6, 65535, 2, 0, 1, 0, 0.61, 0,   2.0,  0.65, 1,  2.1, 1), // 7 L2 fired
  bar(7, 53247, 3, 1, 0, 0, 0.35, 0,   1.0,  0.65, 0,  1.1, 0), // 8 L3+S1 → LS, MacL / MacS
  bar(8, 62815, 8, 0, 0, 0, 0.79, 0,   1.4,  0.65, 1,  1.6, 1), // 9 last row, live (ConfL only)
];
const SERIES = { columns: COLUMNS, rows: ROWS };

test('default profile is well-formed', () => {
  assert.equal(profile.name, 'pf3g-vp');
  assert.equal(profile.gates.length, 16);
  assert.deepEqual([...new Set(profile.gates.map(g => g.bit))].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  assert.equal(Object.keys(profile.reasons).length, 8);
  assert.deepEqual(Object.keys(profile.governingInputs).sort(), ['DSHP', 'MAC', 'PRX', 'RGM', 'ROOM', 'TRD']);
  assert.ok(profile.required.includes('mask'));
});

test('loadProfile accepts a name or an absolute path and rejects unknown names', () => {
  assert.equal(loadProfile('pf3g-vp').name, 'pf3g-vp');
  assert.throws(() => loadProfile('nope-does-not-exist'), /profile/i);
});

test('plotFilterFromProfile joins every column title with | and no title contains |', () => {
  const f = plotFilterFromProfile(profile);
  const parts = f.split('|');
  assert.equal(parts.length, Object.keys(profile.columns).length);
  assert.ok(parts.includes('Audit Final Entry Pass Mask'));
  assert.ok(Object.values(profile.columns).every(t => !t.includes('|')));
});

test('resolveColumns matches on the text after :: case-insensitively and lists missing roles', () => {
  const r = resolveColumns(['time', 'Other Study::AUDIT FINAL ENTRY PASS MASK', 'X::Audit Efficiency Ratio'], profile);
  assert.equal(r.indexByRole.mask, 1);
  assert.equal(r.indexByRole.er, 2);
  assert.ok(r.missing.includes('reasonL'));
  assert.ok(!r.missing.includes('mask'));
});

test('decodeMask lists FAILED gates in bit order (bit=1 means passed)', () => {
  assert.deepEqual(decodeMask(65021, profile).failed, ['RoomL', 'TrdS']);
  assert.deepEqual(decodeMask(65535, profile).failed, []);
  assert.equal(decodeMask(0, profile).failed.length, 16);
  assert.equal(decodeMask(65021, profile).bits.length, 16);
});

test('decodeRegime splits hundreds/tens/ones', () => {
  assert.deepEqual(decodeRegime(121), { raw: 121, active: true, evidence: 2, whipsaw: 1 });
  assert.deepEqual(decodeRegime(0), { raw: 0, active: false, evidence: 0, whipsaw: 0 });
  assert.equal(decodeRegime(null), null);
});

test('pickBlocker follows blockerPriority and uses Conf only when nothing else failed', () => {
  assert.equal(pickBlocker(['RoomL', 'TrdL'], profile), 'TrdL');
  assert.equal(pickBlocker(['ConfL', 'RoomL'], profile), 'RoomL');
  assert.equal(pickBlocker(['ConfL'], profile), 'ConfL');
  assert.equal(pickBlocker([], profile), null);
});

describe('decodeGateAudit verdicts', () => {
  const { verdicts, summary } = decodeGateAudit(SERIES, profile);
  const v = (i) => verdicts[i - 1];

  it('row 1: no pattern → side null, no blocker', () => {
    assert.equal(v(1).side, null);
    assert.equal(v(1).blocker, null);
    assert.equal(v(1).fired, false);
    assert.equal(v(1).iso, '2026-08-26T04:00:00.000Z');
  });
  it('row 2: L8 blocked by RoomL with ROOM inputs and room% < req%', () => {
    assert.equal(v(2).side, 'L');
    assert.equal(v(2).reason, 8);
    assert.equal(v(2).reasonName, 'Healthy Breakout + FVG');
    assert.deepEqual(v(2).failedGates, ['RoomL', 'TrdS']);
    assert.deepEqual(v(2).sideFailedGates, ['RoomL']);
    assert.equal(v(2).blocker, 'RoomL');
    assert.equal(v(2).blockerCode, 'ROOM');
    assert.deepEqual(v(2).governingInputs, profile.governingInputs.ROOM);
    assert.equal(v(2).metrics.roomPct, 0.42);
    assert.equal(v(2).metrics.reqPct, 0.65);
    assert.equal(v(2).metrics.er, 0.44);
  });
  it('row 3: S8 blocked by RoomS', () => {
    assert.equal(v(3).side, 'S');
    assert.deepEqual(v(3).failedGates, ['RoomL', 'TrdL', 'RoomS']);
    assert.equal(v(3).blocker, 'RoomS');
  });
  it('row 4: L8 blocked by RgmL with decoded regime', () => {
    assert.equal(v(4).blocker, 'RgmL');
    assert.equal(v(4).blockerCode, 'RGM');
    assert.deepEqual(v(4).metrics.regime, { raw: 121, active: true, evidence: 2, whipsaw: 1 });
  });
  it('row 5: L8 blocked by MacL with macro -1', () => {
    assert.equal(v(5).blocker, 'MacL');
    assert.equal(v(5).metrics.macro, -1);
    assert.deepEqual(v(5).governingInputs, profile.governingInputs.MAC);
  });
  it('row 6: L7 with RoomL+TrdL failing → TrdL wins by priority', () => {
    assert.deepEqual(v(6).sideFailedGates, ['RoomL', 'TrdL']);
    assert.equal(v(6).blocker, 'TrdL');
    assert.equal(v(6).reasonName, 'Healthy Breakout');
  });
  it('row 7: L2 trigger → fired, no blocker', () => {
    assert.equal(v(7).fired, true);
    assert.equal(v(7).blocker, null);
    assert.equal(v(7).reasonName, 'Pin/POC Rebound');
  });
  it('row 8: L3 + S1 on one bar → side LS with secondary short verdict', () => {
    assert.equal(v(8).side, 'LS');
    assert.equal(v(8).reason, 3);
    assert.equal(v(8).blocker, 'MacL');
    assert.equal(v(8).secondary.side, 'S');
    assert.equal(v(8).secondary.reason, 1);
    assert.equal(v(8).secondary.reasonName, 'Absorption');
    assert.equal(v(8).secondary.blocker, 'MacS');
  });
  it('row 9: last row with only ConfL failing → live, not blocked', () => {
    assert.equal(v(9).live, true);
    assert.deepEqual(v(9).sideFailedGates, ['ConfL']);
    assert.equal(v(9).blocker, 'ConfL');
    assert.equal(v(9).blockerCode, null);
  });
  it('summary counts, histogram and range', () => {
    assert.equal(summary.bars, 9);
    assert.equal(summary.patternBars, 8);
    assert.equal(summary.fired, 1);
    assert.equal(summary.blocked, 6);
    assert.equal(summary.live, 1);
    assert.deepEqual(summary.blockerHistogram, { RoomL: 1, RoomS: 1, RgmL: 1, MacL: 2, TrdL: 1 });
    assert.equal(summary.firstIso, '2026-08-26T04:00:00.000Z');
    assert.equal(summary.lastIso, '2026-08-26T06:00:00.000Z');
    assert.deepEqual(summary.missingColumns, ['dshapeState', 'dshapeRotation', 'supertrend']);
  });
});

test('a non-last row with only Conf failing is reported but not live', () => {
  const rows = [bar(0, 62815, 8, 0, 0, 0, 0.5, 0, 1, 0.65, 0, 1, 1), bar(1, 65535, 0, 0, 0, 0, 0.5, 0, 1, 0.65, 0, 1, 1)];
  const { verdicts, summary } = decodeGateAudit({ columns: COLUMNS, rows }, profile);
  assert.equal(verdicts[0].live, false);
  assert.equal(verdicts[0].blocker, 'ConfL');
  assert.equal(summary.live, 0);
});

test('missing optional columns give null metrics and are listed; missing mask throws', () => {
  const cols = ['time', P + 'Audit Final Entry Pass Mask', P + 'Audit Long Execution Reason'];
  const { verdicts, summary } = decodeGateAudit({ columns: cols, rows: [[T0, 65021, 8, 0]] }, profile);
  assert.equal(verdicts[0].blocker, 'RoomL');
  assert.equal(verdicts[0].metrics.er, null);
  assert.equal(verdicts[0].metrics.regime, null);
  assert.ok(summary.missingColumns.includes('er'));
  assert.throws(() => decodeGateAudit({ columns: ['time', P + 'Audit Efficiency Ratio'], rows: [] }, profile), /Audit Final Entry Pass Mask/);
});

test('null mask cell → mask null, side null, not a pattern bar', () => {
  const { verdicts, summary } = decodeGateAudit({ columns: COLUMNS, rows: [bar(0, null, 8, 0, 0, 0, 0.5, 0, 1, 0.65, 0, 1, 1)] }, profile);
  assert.equal(verdicts[0].mask, null);
  assert.equal(verdicts[0].side, null);
  assert.equal(summary.patternBars, 0);
});

test('timestamps in milliseconds produce the same ISO', () => {
  const { verdicts } = decodeGateAudit({ columns: COLUMNS, rows: [[T0 * 1000, ...ROWS[0].slice(1)]] }, profile);
  assert.equal(verdicts[0].iso, '2026-08-26T04:00:00.000Z');
});

test('empty rows → no verdicts and null range', () => {
  const { verdicts, summary } = decodeGateAudit({ columns: COLUMNS, rows: [] }, profile);
  assert.deepEqual(verdicts, []);
  assert.equal(summary.bars, 0);
  assert.equal(summary.firstIso, null);
  assert.equal(summary.lastIso, null);
});

test('decodeGateAudit does not mutate its inputs', () => {
  const copy = JSON.parse(JSON.stringify(SERIES));
  decodeGateAudit(SERIES, profile);
  assert.deepEqual(SERIES, copy);
});
