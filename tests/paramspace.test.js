import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerate, seedFromMeta, resolveLabels, normalizeSpace, expandGrid, sampleRandom, neighbors, halvingPlan, countEvals, planSpace, coords, pointKey, MAX_EVALS } from '../src/core/paramspace.js';
import { loadProfile } from '../src/core/gateAudit.js';

const META = [
  { id: 'in_3', name: 'Trend Gate Mode', type: 'text', options: ['Off', 'Warning Only', 'Soft Filter', 'Hard Filter'], defval: 'Soft Filter' },
  { id: 'in_7', name: 'ER Range Threshold', type: 'float', min: 0.05, max: 0.6, step: 0.05, defval: 0.25 },
  { id: 'in_9', name: 'Regime Confirmation Bars', type: 'integer', min: 1, max: 10, defval: 3 },
  { id: 'in_12', name: 'Show Zones', type: 'bool', defval: true },
  { id: 'in_20', name: 'Color', type: 'color', defval: '#fff' },
  { id: 'in_21', name: 'Free text', type: 'text', defval: 'x' },
];

test('enumerate: decimal by step with ≤3 decimals, int, bool, categorical; rejects sub-mill steps', () => {
  assert.deepEqual(enumerate({ type: 'decimal', min: 0.2, max: 0.35, step: 0.05 }), [0.2, 0.25, 0.3, 0.35]);
  assert.deepEqual(enumerate({ type: 'int', min: 2, max: 5 }), [2, 3, 4, 5]);
  assert.deepEqual(enumerate({ type: 'bool' }), [true, false]);
  assert.deepEqual(enumerate({ type: 'categorical', values: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(enumerate({ type: 'decimal', min: 0, max: 1 }), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], 'default step = range/10');
  assert.throws(() => enumerate({ type: 'decimal', min: 0, max: 1, step: 0.0001 }), /decimals/);
  assert.throws(() => enumerate({ type: 'int', min: 5, max: 1 }), /min\/max/);
});

test('seedFromMeta keeps only inputs with options or bounds, skips colors and free text', () => {
  const p = seedFromMeta(META);
  assert.deepEqual(p.map((x) => x.id), ['in_3', 'in_7', 'in_9', 'in_12']);
  assert.equal(p[0].type, 'categorical'); assert.equal(p[1].type, 'decimal'); assert.equal(p[2].type, 'int'); assert.equal(p[3].type, 'bool');
  assert.equal(p[1].step, 0.05); assert.equal(p[0].current, 'Soft Filter');
});

test('resolveLabels maps the profile shortlist to ids case-insensitively and names missing labels', () => {
  const sl = loadProfile().optimize.shortlist;
  assert.equal(sl.length, 16);
  const r = resolveLabels(sl.filter((s) => ['Trend Gate Mode', 'ER Range Threshold', 'regime confirmation bars'].includes(s.label) || s.label === 'Regime Confirmation Bars'), META);
  assert.deepEqual(r.map((x) => x.id), ['in_3', 'in_7', 'in_9']);
  assert.deepEqual(r[0].values, ['Soft Filter', 'Hard Filter']);
  assert.equal(r[1].type, 'decimal'); assert.equal(r[1].min, 0.15); assert.equal(r[2].type, 'int');
  assert.throws(() => resolveLabels([{ label: 'Nope', values: [1] }], META), /Nope/);
});

test('normalizeSpace: enumerates, defaults, caps the grid at 64 with the count in the error', () => {
  const sp = normalizeSpace({ params: [{ id: 'in_3', label: 'Trend Gate Mode', values: ['Soft Filter', 'Hard Filter'] }, { id: 'in_7', label: 'ER', type: 'decimal', min: 0.2, max: 0.35, step: 0.05 }] });
  assert.equal(sp.sampler.kind, 'grid'); assert.equal(sp.objective, 'multi_metric'); assert.equal(sp.topK, 3); assert.equal(sp.sampler.earlyStop.patience, 10);
  assert.equal(countEvals(sp), 8);
  assert.throws(() => normalizeSpace({ params: [{ id: 'a', type: 'int', min: 1, max: 10 }, { id: 'b', type: 'int', min: 1, max: 10 }] }), /100 evaluations \(cap 64\)/);
  assert.throws(() => normalizeSpace({ params: [] }), /at least one/);
  assert.throws(() => normalizeSpace('{oops'), /valid JSON/);
  const rnd = normalizeSpace({ params: [{ id: 'a', type: 'int', min: 1, max: 10 }, { id: 'b', type: 'int', min: 1, max: 10 }], sampler: { kind: 'random', n: 5 } });
  assert.equal(countEvals(rnd), 5);
});

test('expandGrid order, sampleRandom distinct+deterministic, neighbors at edges, halving stage 2 skips evaluated points', () => {
  const sp = normalizeSpace({ params: [{ id: 'g', values: ['Soft', 'Hard'] }, { id: 'e', type: 'decimal', min: 0.2, max: 0.35, step: 0.05 }] });
  const grid = expandGrid(sp);
  assert.equal(grid.length, 8); assert.deepEqual(grid[0], { g: 'Soft', e: 0.2 }); assert.deepEqual(grid[7], { g: 'Hard', e: 0.35 });
  const big = normalizeSpace({ params: [{ id: 'a', type: 'int', min: 1, max: 10 }, { id: 'b', type: 'int', min: 1, max: 10 }], sampler: { kind: 'random', n: 6, seed: 3 } });
  const s1 = sampleRandom(big), s2 = sampleRandom(big);
  assert.equal(s1.length, 6); assert.deepEqual(s1, s2); assert.equal(new Set(s1.map(pointKey)).size, 6);
  assert.deepEqual(sampleRandom(sp, 50).length, 8, 'a small grid is returned whole');
  const nb = neighbors({ g: 'Soft', e: 0.2 }, sp);
  assert.deepEqual(nb, [{ g: 'Hard', e: 0.2 }, { g: 'Soft', e: 0.25 }]);
  assert.deepEqual(coords({ g: 'Hard', e: 0.35 }, sp), [1, 1]);
  const h = halvingPlan(big, { n0: 4, top: 1 });
  assert.equal(h.stage1.length, 4);
  const results = h.stage1.map((inputs, i) => ({ inputs, objective: i === 0 ? -5 : 0 }));
  const st2 = h.stage2(results);
  assert.ok(st2.length >= 1 && st2.length <= 4);
  assert.ok(st2.every((p) => !results.some((r) => pointKey(r.inputs) === pointKey(p))), 'stage 2 never repeats an evaluated point');
  assert.equal(planSpace(sp, { settleMs: 20000, paceMs: 1000 }).estimateMs, 8 * 21000);
  assert.equal(MAX_EVALS, 64);
});
