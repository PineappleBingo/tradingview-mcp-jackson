/**
 * Phase 4 — selection and verdict over sweep results (pure).
 *
 * Rank by objective on in-sample metrics, check the top-k out-of-sample, prefer a plateau
 * centre over an isolated peak (neighbour stability — freqtrade's "different random states
 * give different winners" warning made mechanical), take the Monte-Carlo p-value of the
 * selected run, and decide edge | noise | insufficient with the explicit Hold escape hatch
 * (TradingAgents research-manager). Decisions are report cards that a later backtest of the
 * same configHash resolves (TradingAgents TradingMemoryLog pending → resolved).
 */
import { computeMetrics, splitByDate, verdictOf } from './validate.js';
import { score } from './objectives.js';
import { coords, pointKey, neighbors } from './paramspace.js';

export const METRIC_KEYS = ['netProfit', 'netProfitPct', 'totalTrades', 'winRate', 'profitFactor', 'maxDrawdown', 'maxDrawdownPct', 'avgTrade', 'expectancyRatio', 'sharpe', 'sortino', 'calmar', 'maxConsecLosses', 'grossProfit', 'grossLoss'];
export const compact = (m) => Object.fromEntries(METRIC_KEYS.map((k) => [k, m && m[k] !== undefined ? m[k] : null]));

const toMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));

/** ≤ n points of cumulative P&L (net % when the trades carry pnlPct, else money) for the overlay. */
export function curveOf(trades, n = 60) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  if (!ts.length) return [];
  const pct = ts.every((t) => typeof t.pnlPct === 'number');
  let c = 0; const cum = ts.map((t) => { c += pct ? t.pnlPct : t.pnl; return Math.round(c * 1000) / 1000; });
  if (cum.length <= n) return cum;
  const stride = cum.length / n;
  const out = []; for (let i = 0; i < n; i++) out.push(cum[Math.min(cum.length - 1, Math.floor((i + 1) * stride) - 1)]);
  return out;
}

/** One journal-sized result from a RunCard. IS metrics come from the trades before splitDate. */
export function summarizeRun(card, { index, inputs, objective, splitDate = null, initialCapital = null } = {}) {
  const trades = card.trades || [];
  let isMetrics = compact(card.metrics);
  let oos = null;
  if (splitDate) {
    const cut = toMs(splitDate);
    const isT = trades.filter((t) => (toMs(t.exitTime) || 0) < cut), oosT = trades.filter((t) => (toMs(t.exitTime) || 0) >= cut);
    isMetrics = compact(computeMetrics(isT, { initialCapital }));
    const om = computeMetrics(oosT, { initialCapital });
    oos = { n: om.totalTrades, netProfit: om.netProfit, profitFactor: om.profitFactor, sharpe: om.sharpe };
  } else if (card.validation && card.validation.split) {
    oos = card.validation.split.oos;
  }
  return {
    index, inputs: inputs || (card.config && card.config.inputs) || {}, configHash: card.config && card.config.configHash,
    metrics: compact(card.metrics), isMetrics, oos,
    objective: score(objective, isMetrics), settled: !!card.settled, settleMs: card.settleMs ?? null, warnings: card.warnings || [], curve: curveOf(trades),
    pSharpe: card.validation && card.validation.monteCarlo ? card.validation.monteCarlo.pSharpe : null,
    verdict: card.validation ? card.validation.verdict : null, reportId: card.reportId || null,
  };
}

/** Indices sorted by objective ascending (smaller is better); null objectives last. */
export function rank(results) {
  return results.map((r, i) => ({ i, o: r.objective })).sort((a, b) => (a.o == null) - (b.o == null) || (a.o ?? 0) - (b.o ?? 0)).map((x) => x.i);
}

/**
 * Mean objective of the evaluated grid neighbours (±1 step on one axis); when none were
 * evaluated (random/halving spaces) the k nearest points by normalised axis distance.
 */
export function stabilityOf(results, i, space, k = 3) {
  if (!space || !space.params || results.length < 2) return null;
  const byKey = new Map(results.map((r) => [pointKey(r.inputs), r]));
  const nb = neighbors(results[i].inputs, space).map((p) => byKey.get(pointKey(p))).filter((r) => r && r.objective != null);
  if (nb.length) return Math.round(nb.reduce((a, r) => a + r.objective, 0) / nb.length * 1e6) / 1e6;
  const c0 = coords(results[i].inputs, space);
  const near = results.map((r, j) => ({ j, d: j === i ? Infinity : Math.hypot(...coords(r.inputs, space).map((c, a) => c - c0[a])) }))
    .filter((x) => x.d !== Infinity && results[x.j].objective != null).sort((a, b) => a.d - b.d).slice(0, k);
  if (!near.length) return null;
  return Math.round(near.reduce((a, x) => a + results[x.j].objective, 0) / near.length * 1e6) / 1e6;
}

/**
 * selection = { ranked, oos:{index→ok}, stability:{index→mean}, selectedIndex, verdict, reasons }
 * Selected = the top-k candidate with the best (objective + stability) / 2.
 */
export function selectAndVerdict(results, { space = null, baseline = null, topK = 3, minSettledRuns = 8 } = {}) {
  const ranked = rank(results);
  const settledRuns = results.filter((r) => r.settled).length;
  const top = ranked.filter((i) => results[i].objective != null).slice(0, topK);
  const oos = {}, stability = {};
  let selectedIndex = null, best = Infinity;
  for (const i of top) {
    const r = results[i];
    oos[i] = r.oos ? (r.oos.profitFactor != null && r.oos.profitFactor > 1 && r.oos.netProfit > 0) : null;
    const st = stabilityOf(results, i, space);
    stability[i] = st;
    const cand = st == null ? r.objective : (r.objective + st) / 2;
    if (cand < best) { best = cand; selectedIndex = i; }
  }
  if (selectedIndex == null) return { ranked, oos, stability, selectedIndex: null, verdict: 'insufficient', reasons: ['no run produced an objective value'], baseline: baseline ? baseline.objective : null };
  const s = results[selectedIndex];
  const objectiveBetter = baseline && baseline.objective != null && s.objective != null ? s.objective < baseline.objective : null;
  const v = verdictOf({ n: (s.isMetrics && s.isMetrics.totalTrades) || (s.metrics && s.metrics.totalTrades) || 0, settled: s.settled, pSharpe: s.pSharpe, oos: s.oos, objectiveBetter, settledRuns, minSettledRuns });
  const plateau = stability[selectedIndex] != null && ranked[0] !== selectedIndex ? 'selected the plateau centre over the peak' : null;
  return { ranked, oos, stability, selectedIndex, verdict: v.verdict, reasons: plateau ? [...v.reasons, plateau] : v.reasons, baseline: baseline ? baseline.objective : null, settledRuns };
}

/** A pending decision is resolved by a later run of the same config whose window extends past the sweep's. */
export function decisionResolvedBy(decision, card) {
  if (!decision || !card || decision.status !== 'pending') return false;
  if (!decision.configHash || decision.configHash !== (card.config && card.config.configHash)) return false;
  const after = card.window && card.window.lastTradeTime ? toMs(card.window.lastTradeTime) : 0;
  const upto = decision.lastTradeTime ? toMs(decision.lastTradeTime) : 0;
  return after > upto;
}

/** Realised out-of-sample figures for a resolved decision: trades after the decision's window. */
export function realizedFor(decision, card, { initialCapital = null } = {}) {
  const cut = decision.lastTradeTime ? toMs(decision.lastTradeTime) : 0;
  const m = computeMetrics((card.trades || []).filter((t) => (toMs(t.exitTime) || 0) > cut), { initialCapital });
  return { n: m.totalTrades, netProfit: m.netProfit, profitFactor: m.profitFactor, winRate: m.winRate, from: decision.lastTradeTime || null, to: card.window ? card.window.lastTradeTime : null };
}

/** Matrix for exactly two parameters: rows = param[0] values, cols = param[1] values, cell = objective (null when not evaluated). */
export function matrixOf(results, space) {
  if (!space || !space.params || space.params.length !== 2) return null;
  const [a, b] = space.params;
  const byKey = new Map(results.map((r) => [pointKey(r.inputs), r]));
  return { rowParam: a.label || a.id, colParam: b.label || b.id, rows: a.values, cols: b.values,
    cells: a.values.map((va) => b.values.map((vb) => { const r = byKey.get(pointKey({ [a.id]: va, [b.id]: vb })); return r ? { index: r.index, objective: r.objective, netProfitPct: r.metrics.netProfitPct } : null; })) };
}
