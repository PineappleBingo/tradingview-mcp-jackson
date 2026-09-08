/**
 * Counterfactual replay over gate-audit verdicts — "would this rule have blocked that entry?"
 *
 * PF 3G VP is an indicator(), so it has no Strategy Tester and nothing in Phase 3/4 can
 * backtest a proposed change to it. But decodeGateAudit() already carries per-bar metrics for
 * every bar, which is enough to decide a single-bar rule against history with no chart access
 * and no re-run. This module is that decision, kept pure so it is testable and so a model can
 * never talk it into a "verified".
 *
 * Two rule kinds, because the two directions are not symmetric:
 *
 *   { kind: 'require', pred }        an EXTRA condition entries must meet   FIRED  → BLOCKED
 *   { kind: 'relax', gates: [...] }  treat these gates as passing           BLOCKED → FIRED
 *
 * `relax` is the Phase 4b "treat gate X as pass" panel's engine (docs/phase-plan/
 * phase-4-optimize.md §4b); `require` is what verifies a recommendation.
 *
 * A predicate is JSON, never code — no eval, no new Function. `metric` is a key into the fixed
 * METRICS table below, so "__proto__", "constructor" and a typo all take the same rejected
 * path. Nothing here throws: a malformed rule returns { valid:false, reason }, because the
 * caller is a language model and a thrown error is easier to mistake for "no problems found"
 * than an explicit refusal is.
 *
 *   pred := { metric, op, value } | { all: [pred…] } | { any: [pred…] } | { not: pred }
 *   op   := gt | gte | lt | lte | eq | ne | between
 *   value:= number | boolean | string | [lo, hi] | { metric, mul?, add? }
 *
 * CAN express: any single-bar threshold, band, ratio between two audited metrics, side /
 * pattern / hour restriction, and boolean combinations of those.
 *
 * CANNOT express, and callers must label these UNVERIFIABLE rather than approximate them:
 *   - cross-bar state ("three bars in a row", "within 5 bars of a regime flip", "re-entry
 *     cooldown") — every predicate sees exactly one bar
 *   - anything not plotted in the profile's audit columns (structure-level distances, intrabar
 *     path, a different ATR length, higher-timeframe values)
 *   - anything needing new Pine computation
 *   - anything about the outcome (P&L, MAE/MFE) — verdicts carry no trade results
 */

// Metric accessors. A fixed table, not a property path: this IS the injection defence.
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const m = (key) => (v) => num(v && v.metrics ? v.metrics[key] : null);
const regime = (key) => (v) => {
  const r = v && v.metrics && v.metrics.regime;
  return r ? (key === 'active' ? !!r.active : num(r[key])) : null;
};

const METRICS = {
  er: m('er'),
  roomPct: m('roomPct'),
  reqPct: m('reqPct'),
  targetRoomAtr: m('targetRoomAtr'),
  macro: m('macro'),
  volGate: m('volGate'),
  dshapeState: m('dshapeState'),
  dshapeRotation: m('dshapeRotation'),
  supertrend: m('supertrend'),
  'regime.raw': regime('raw'),
  'regime.active': regime('active'),
  'regime.evidence': regime('evidence'),
  'regime.whipsaw': regime('whipsaw'),
  // Verdict-level, not in metrics — recommendations reach for these constantly.
  side: (v) => (v && v.side ? String(v.side) : null),
  reason: (v) => num(v && v.reason),
  hourUTC: (v) => (v && v.iso ? Number(v.iso.slice(11, 13)) : null),
};

export const METRIC_NAMES = Object.keys(METRICS);

const OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
};

const MAX_CHILDREN = 8;
const MAX_DEPTH = 4;
// Below this many evaluable entries the flip count is noise, not evidence.
const MIN_EVALUABLE = 5;
// A rule we cannot read on most bars has not been tested, however the readable bars fell.
const MAX_UNKNOWN_SHARE = 0.5;

const frag = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };
const isPlainObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

/**
 * Validate a predicate tree and collect the metrics it reads.
 * Returns null on success (touched is filled in place) or a reason string on failure.
 */
function checkPred(pred, touched, depth) {
  if (depth > MAX_DEPTH) return `predicate nested deeper than ${MAX_DEPTH}`;
  if (!isPlainObject(pred)) return `predicate must be an object, got ${frag(pred)}`;

  for (const key of ['all', 'any']) {
    if (key in pred) {
      const kids = pred[key];
      if (!Array.isArray(kids) || kids.length === 0) return `"${key}" must be a non-empty array`;
      if (kids.length > MAX_CHILDREN) return `"${key}" has ${kids.length} children, max ${MAX_CHILDREN}`;
      for (const k of kids) {
        const bad = checkPred(k, touched, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
  }
  if ('not' in pred) return checkPred(pred.not, touched, depth + 1);

  if (!('metric' in pred)) return `predicate has no metric, all, any or not: ${frag(pred)}`;
  if (!Object.prototype.hasOwnProperty.call(METRICS, pred.metric)) {
    return `unknown metric ${frag(pred.metric)} — known: ${METRIC_NAMES.join(', ')}`;
  }
  touched.add(pred.metric);

  const op = pred.op;
  if (op !== 'between' && !Object.prototype.hasOwnProperty.call(OPS, op)) {
    return `unknown op ${frag(op)} — known: ${Object.keys(OPS).join(', ')}, between`;
  }

  const val = pred.value;
  if (op === 'between') {
    if (!Array.isArray(val) || val.length !== 2 || !val.every((n) => Number.isFinite(n))) {
      return `"between" needs [lo, hi] of finite numbers, got ${frag(val)}`;
    }
    return null;
  }
  if (isPlainObject(val)) {
    if (!Object.prototype.hasOwnProperty.call(METRICS, val.metric)) {
      return `unknown metric ${frag(val.metric)} on the right-hand side of ${frag(pred.metric)}`;
    }
    if (val.mul != null && !Number.isFinite(val.mul)) return `"mul" must be finite, got ${frag(val.mul)}`;
    if (val.add != null && !Number.isFinite(val.add)) return `"add" must be finite, got ${frag(val.add)}`;
    touched.add(val.metric);
    return null;
  }
  if (typeof val === 'boolean' || typeof val === 'string') return null;
  if (Number.isFinite(val)) return null;
  return `value must be a number, boolean, string, [lo,hi] or {metric,mul,add}, got ${frag(val)}`;
}

/** Three-valued: true | false | null. null means "a metric this needed was not readable". */
function evalPred(pred, v) {
  if ('all' in pred) {
    let unknown = false;
    for (const k of pred.all) {
      const r = evalPred(k, v);
      if (r === false) return false;       // one definite failure settles it
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in pred) {
    let unknown = false;
    for (const k of pred.any) {
      const r = evalPred(k, v);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in pred) {
    const r = evalPred(pred.not, v);
    return r === null ? null : !r;
  }

  const left = METRICS[pred.metric](v);
  if (left === null) return null;

  if (pred.op === 'between') {
    const [lo, hi] = pred.value;
    return left >= lo && left <= hi;
  }
  let right = pred.value;
  if (isPlainObject(right)) {
    const base = METRICS[right.metric](v);
    if (base === null) return null;
    right = base * (right.mul == null ? 1 : right.mul) + (right.add == null ? 0 : right.add);
  }
  return OPS[pred.op](left, right);
}

/**
 * Validate a rule and return a runnable test, or an explicit refusal. Never throws.
 * @returns {{valid:true, kind:string, touched:string[], test:(v:object)=>(boolean|null)}
 *          |{valid:false, reason:string}}
 */
export function compileRule(rule) {
  if (!isPlainObject(rule)) return { valid: false, reason: `rule must be an object, got ${frag(rule)}` };

  if (rule.kind === 'relax') {
    const gates = rule.gates;
    if (!Array.isArray(gates) || gates.length === 0 || !gates.every((g) => typeof g === 'string' && g)) {
      return { valid: false, reason: `"relax" needs gates: ["RoomL", …], got ${frag(gates)}` };
    }
    const set = new Set(gates);
    // A bar unblocks only when EVERY gate that failed on it is one we are relaxing.
    return {
      valid: true, kind: 'relax', gates: [...set], touched: [],
      test: (v) => {
        const failed = v.sideFailedGates || [];
        return failed.length > 0 && failed.every((g) => set.has(g));
      },
    };
  }

  if (rule.kind !== 'require') {
    return { valid: false, reason: `kind must be "require" or "relax", got ${frag(rule.kind)}` };
  }
  const touched = new Set();
  const bad = checkPred(rule.pred, touched, 1);
  if (bad) return { valid: false, reason: bad };
  return { valid: true, kind: 'require', touched: [...touched], test: (v) => evalPred(rule.pred, v) };
}

const isPattern = (v) => Number(v && v.reason) > 0;
const isBlocked = (v) => !v.fired && !v.live && !!v.blocker;

function valuesOf(v, touched) {
  const out = {};
  for (const k of touched) out[k] = METRICS[k](v);
  return out;
}

function matchesIso(v, atIso) {
  return typeof v.iso === 'string' && (v.iso === atIso || v.iso.startsWith(atIso));
}

/**
 * Replay a rule over decoded verdicts. Pure; never throws.
 * @param {Array} verdicts  from decodeGateAudit()
 * @param {object} rule     { kind:'require', pred } | { kind:'relax', gates }
 * @param {{atIso?:string}} opts  atIso = the bar under review (full ISO or a prefix)
 */
export function replay(verdicts, rule, { atIso = null } = {}) {
  const c = compileRule(rule);
  const rows = Array.isArray(verdicts) ? verdicts : [];
  const window = {
    bars: rows.length,
    firstIso: rows.length ? rows[0].iso : null,
    lastIso: rows.length ? rows[rows.length - 1].iso : null,
  };
  if (!c.valid) {
    return {
      valid: false, reason: c.reason, kind: null, touched: [],
      counts: null, flips: [], unblocks: [], unknownBars: [], target: null, window,
      verdict: 'invalid',
    };
  }

  const counts = {
    patternBars: 0,
    fired: { before: 0, after: 0 },
    flipped: 0, unblocked: 0, unknown: 0,
  };
  const flips = [];
  const unblocks = [];
  const unknownBars = [];
  const state = new Map(); // iso → { was, now }

  for (const v of rows) {
    if (isPattern(v)) counts.patternBars += 1;
    if (v.fired) counts.fired.before += 1;

    const was = v.fired ? 'FIRED' : (v.live ? 'LIVE' : (v.blocker ? 'BLOCKED' : 'NONE'));
    let now = was;

    if (c.kind === 'require' && v.fired) {
      const r = c.test(v);
      if (r === null) { counts.unknown += 1; unknownBars.push(v.iso); }
      else if (r === false) {
        now = 'BLOCKED';
        counts.flipped += 1;
        flips.push({
          iso: v.iso, t: v.t, side: v.side, reason: v.reason, reasonName: v.reasonName,
          was: 'FIRED', now: 'BLOCKED', values: valuesOf(v, c.touched),
        });
      }
    } else if (c.kind === 'relax' && isBlocked(v)) {
      if (c.test(v)) {
        now = 'FIRED';
        counts.unblocked += 1;
        unblocks.push({
          iso: v.iso, t: v.t, side: v.side, reason: v.reason, reasonName: v.reasonName,
          was: 'BLOCKED', now: 'FIRED', gates: v.sideFailedGates || [],
        });
      }
    }

    if (now === 'FIRED') counts.fired.after += 1;
    if (atIso && matchesIso(v, atIso) && !state.has('target')) state.set('target', { iso: v.iso, was, now });
  }

  const t = state.get('target');
  const target = atIso
    ? (t ? { ...t, found: true, flipped: t.was !== t.now } : { iso: atIso, found: false, was: null, now: null, flipped: false })
    : null;

  // A rule read on too few bars, or unreadable on most of the ones it touched, has not been
  // tested — say so rather than reporting the flips it happened to see.
  const considered = c.kind === 'require' ? counts.fired.before : rows.filter(isBlocked).length;
  const evaluable = considered - counts.unknown;
  let verdict;
  if (evaluable < MIN_EVALUABLE || (considered > 0 && counts.unknown / considered > MAX_UNKNOWN_SHARE)) {
    verdict = 'insufficient';
  } else if (counts.flipped === 0 && counts.unblocked === 0) {
    verdict = 'no-effect';
  } else {
    verdict = 'effective';
  }

  return {
    valid: true, kind: c.kind, touched: c.touched,
    counts, flips, unblocks, unknownBars, target, window, verdict,
  };
}
