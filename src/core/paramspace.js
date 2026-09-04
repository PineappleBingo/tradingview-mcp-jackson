/**
 * Phase 4 — typed, finite parameter space for sweeps.
 *
 * Patterns re-implemented (no code copied): freqtrade's IntParameter / DecimalParameter /
 * CategoricalParameter / BooleanParameter and its "SKDecimal over Real" policy — every numeric
 * axis is enumerated up front with ≤ 3 decimals so the space is finite and printable; an
 * unbounded real axis is how spurious-precision winners appear. Bounds come from the study's
 * own metaInfo (PF 3G VP declares min/max/step positionally for 86 numeric inputs), from the
 * profile shortlist (a narrower sweep window keyed by label), or from the user.
 */
export const MAX_EVALS = 64;
export const DEFAULT_RANDOM_N = 16;
export const HALVING = { n0: 16, top: 4 };
export const MAX_DECIMALS = 3;
export const DEFAULT_PATIENCE = 10;

const canon = (v) => JSON.stringify(v, Object.keys(v).sort());
export const pointKey = (point) => canon(point || {});

export function decimalsOf(x) {
  const s = String(x);
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
const roundTo = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Enumerate a parameter's values (categorical as given, numeric min..max by step). */
export function enumerate(p) {
  if (Array.isArray(p.values) && p.values.length) return p.values.slice();
  if (p.type === 'bool') return [true, false];
  if (p.type === 'int' || p.type === 'decimal') {
    const min = Number(p.min), max = Number(p.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) throw new Error(`parameter ${p.label || p.id}: min/max required (got ${p.min}..${p.max})`);
    let step = Number(p.step);
    if (!Number.isFinite(step) || step <= 0) step = p.type === 'int' ? 1 : roundTo((max - min) / 10, MAX_DECIMALS) || 1;
    const dec = p.type === 'int' ? 0 : Math.min(MAX_DECIMALS, Math.max(decimalsOf(step), decimalsOf(min), p.decimals ?? 0));
    if (p.type === 'decimal' && decimalsOf(step) > MAX_DECIMALS) throw new Error(`parameter ${p.label || p.id}: step ${step} needs more than ${MAX_DECIMALS} decimals`);
    const out = [];
    for (let k = 0; k <= Math.floor((max - min) / step + 1e-9) && out.length <= 10000; k++) out.push(roundTo(min + k * step, dec));
    if (p.type === 'int') return [...new Set(out.map((v) => Math.round(v)))];
    return out;
  }
  throw new Error(`parameter ${p.label || p.id}: unknown type ${p.type}`);
}

const typeOf = (m) => {
  if (Array.isArray(m.options) && m.options.length) return 'categorical';
  const t = String(m.type || '').toLowerCase();
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t === 'integer' || t === 'int') return 'int';
  if (t === 'float' || t === 'price' || t === 'decimal' || t === 'number') return 'decimal';
  return null;
};

/**
 * Seed parameters from metaInfo inputs: options, bools, and numerics. TradingView fills an
 * unbounded numeric input with ±1e12 sentinels (verified live, Desktop 3.4), and a nominal
 * bound like pyramiding 0..1e6 is useless as an axis, so anything that would not enumerate
 * to ≤ 100 values gets five points around its current value instead.
 */
const SENTINEL = 1e9, MAX_SEED_VALUES = 100;
export function seedFromMeta(metaInputs) {
  const out = [];
  for (const m of metaInputs || []) {
    if (!m || !/^in_/.test(m.id || '')) continue;
    const type = typeOf(m);
    if (!type) continue;
    const cur = m.cur ?? m.def ?? m.defval;
    const base = { id: m.id, label: m.name, type, source: 'metaInfo', current: cur };
    if (type === 'categorical') { out.push({ ...base, values: m.options.slice() }); continue; }
    if (type === 'bool') { out.push({ ...base, values: [true, false] }); continue; }
    const min = Number(m.min), max = Number(m.max), step = m.step != null ? Number(m.step) : undefined;
    const bounded = Number.isFinite(min) && Number.isFinite(max) && Math.abs(min) < SENTINEL && Math.abs(max) < SENTINEL && max > min;
    const count = bounded ? (max - min) / (Number.isFinite(step) && step > 0 ? step : (type === 'int' ? 1 : (max - min) / 10)) : Infinity;
    if (count <= MAX_SEED_VALUES) { out.push({ ...base, min, max, step }); continue; }
    const c = Number(cur);
    if (!Number.isFinite(c) || c === 0) continue;
    // ponytail: ±50 % around the current value in 5 steps; a real range belongs in the profile shortlist
    const dec = type === 'int' ? 0 : Math.min(MAX_DECIMALS, decimalsOf(Number.isFinite(step) && step > 0 ? step : c));
    const values = [...new Set([0.5, 0.75, 1, 1.25, 1.5].map((f) => roundTo(c * f, dec)))];
    if (values.length > 1) out.push({ ...base, values });
  }
  return out;
}

/** Resolve a shortlist (keyed by label) against metaInfo inputs → params with ids. */
export function resolveLabels(shortlist, metaInputs) {
  const meta = metaInputs || [];
  const find = (label) => {
    const l = String(label).toLowerCase();
    return meta.find((m) => String(m.name || '').toLowerCase() === l) || meta.find((m) => String(m.name || '').toLowerCase().includes(l));
  };
  const out = [], missing = [];
  for (const s of shortlist || []) {
    const m = find(s.label);
    if (!m) { missing.push(s.label); continue; }
    const type = s.type || (Array.isArray(s.values) ? (typeof s.values[0] === 'boolean' ? 'bool' : 'categorical') : (Number.isInteger(s.step ?? 1) && Number.isInteger(s.min) && Number.isInteger(s.max) ? 'int' : 'decimal'));
    out.push({ id: m.id, label: m.name, type, ...(s.values ? { values: s.values.slice() } : { min: s.min, max: s.max, step: s.step, decimals: s.decimals }), source: 'profile', group: s.group, current: m.cur ?? m.def ?? m.defval });
  }
  if (missing.length) throw new Error('shortlist labels not found on this study: ' + missing.join(', '));
  return out;
}

/** Fill defaults, enumerate every axis, validate the sampler. */
export function normalizeSpace(raw) {
  let s = raw;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { throw new Error('space must be valid JSON'); } }
  s = s && typeof s === 'object' ? s : {};
  const params = (s.params || []).map((p) => {
    if (!p || !p.id) throw new Error('every parameter needs an id (in_N)');
    const type = p.type || (Array.isArray(p.values) ? (typeof p.values[0] === 'boolean' ? 'bool' : 'categorical') : 'decimal');
    const q = { ...p, type, source: p.source || 'user' };
    q.values = enumerate(q);
    if (!q.values.length) throw new Error(`parameter ${q.label || q.id}: no values`);
    return q;
  });
  if (!params.length) throw new Error('space needs at least one parameter');
  const sampler = { kind: 'grid', seed: 42, maxEvals: MAX_EVALS, earlyStop: { patience: DEFAULT_PATIENCE }, ...(s.sampler || {}) };
  if (!['grid', 'random', 'halving'].includes(sampler.kind)) throw new Error('sampler.kind must be grid | random | halving');
  sampler.maxEvals = Math.max(1, Math.min(MAX_EVALS, Number(sampler.maxEvals) || MAX_EVALS));
  sampler.n = Math.max(1, Math.min(sampler.maxEvals, Number(sampler.n) || DEFAULT_RANDOM_N));
  sampler.earlyStop = { patience: Math.max(1, Number((sampler.earlyStop || {}).patience) || DEFAULT_PATIENCE) };
  const space = { params, sampler, objective: s.objective || 'multi_metric', splitDate: s.splitDate || null, topK: Math.max(1, Number(s.topK) || 3), pace_ms: s.pace_ms ?? 1000 };
  const total = gridCount(space);
  if (sampler.kind === 'grid' && total > sampler.maxEvals) throw new Error(`grid would be ${total} evaluations (cap ${sampler.maxEvals}); shrink a range or use sampler random/halving`);
  return space;
}

export const gridCount = (space) => space.params.reduce((a, p) => a * p.values.length, 1);
export function countEvals(space) {
  const total = gridCount(space);
  if (space.sampler.kind === 'grid') return total;
  if (space.sampler.kind === 'random') return Math.min(space.sampler.n, total);
  const n0 = Math.min(HALVING.n0, total);
  return Math.min(space.sampler.maxEvals, total, n0 + HALVING.top * space.params.length * 2);
}

export function expandGrid(space, { cap = space.sampler.maxEvals } = {}) {
  const total = gridCount(space);
  if (total > cap) throw new Error(`grid would be ${total} evaluations (cap ${cap})`);
  let points = [{}];
  for (const p of space.params) points = points.flatMap((pt) => p.values.map((v) => ({ ...pt, [p.id]: v })));
  return points;
}

// mulberry32 (same generator as validate.js; duplicated to keep this module dependency-free)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** n distinct random points (all points when the grid is smaller than n). */
export function sampleRandom(space, n = space.sampler.n, seed = space.sampler.seed) {
  const total = gridCount(space);
  if (total <= n) return expandGrid(space, { cap: Infinity });
  const r = rng(seed), seen = new Set(), out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const pt = {};
    for (const p of space.params) pt[p.id] = p.values[Math.floor(r() * p.values.length)];
    const k = pointKey(pt);
    if (!seen.has(k)) { seen.add(k); out.push(pt); }
  }
  return out;
}

/** Points that differ from `point` in exactly one axis by ±1 index. */
export function neighbors(point, space) {
  const out = [];
  for (const p of space.params) {
    const i = p.values.findIndex((v) => String(v) === String(point[p.id]));
    if (i < 0) continue;
    if (i > 0) out.push({ ...point, [p.id]: p.values[i - 1] });
    if (i < p.values.length - 1) out.push({ ...point, [p.id]: p.values[i + 1] });
  }
  return out;
}

/** Normalised position of a point (each axis 0..1) — used for nearest-neighbour stability. */
export function coords(point, space) {
  return space.params.map((p) => { const i = p.values.findIndex((v) => String(v) === String(point[p.id])); return p.values.length > 1 && i >= 0 ? i / (p.values.length - 1) : 0; });
}

/**
 * Successive halving: stage 1 = n0 random points; stage 2 = the ±1-step neighbours of the
 * best `top` points not yet evaluated, within maxEvals.
 */
export function halvingPlan(space, { n0 = HALVING.n0, top = HALVING.top } = {}) {
  const stage1 = sampleRandom(space, Math.min(n0, space.sampler.maxEvals), space.sampler.seed);
  return {
    stage1,
    stage2(results) { // results: [{ inputs, objective }] — smaller objective is better
      const done = new Set(results.map((r) => pointKey(r.inputs)));
      const best = results.filter((r) => r.objective != null).sort((a, b) => a.objective - b.objective).slice(0, top);
      const out = [];
      for (const b of best) for (const nb of neighbors(b.inputs, space)) { const k = pointKey(nb); if (!done.has(k)) { done.add(k); out.push(nb); } }
      return out.slice(0, Math.max(0, space.sampler.maxEvals - results.length));
    },
  };
}

/** Human-readable plan for the viewer's estimate and the CLI. */
export function planSpace(space, { settleMs = 20000, paceMs = 1000 } = {}) {
  const n = countEvals(space);
  return { evaluations: n, grid: gridCount(space), sampler: space.sampler.kind, estimateMs: n * (settleMs + paceMs), params: space.params.map((p) => ({ id: p.id, label: p.label, type: p.type, values: p.values })) };
}
