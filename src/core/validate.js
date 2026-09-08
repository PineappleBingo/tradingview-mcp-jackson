/**
 * Trust layer for backtests: pure statistics over a trade list. No TradingView, no CDP.
 *
 * Every TradingView run covers the whole loaded history, so in-sample / out-of-sample and
 * walk-forward are computed *post hoc* from trade timestamps — no Deep-Backtesting UI
 * automation is needed.
 *
 * Provenance (patterns re-implemented, no code copied):
 *  - Monte-Carlo permutation, bootstrap Sharpe CI, walk-forward windows: HKUDS/Vibe-Trading
 *    agent/backtest/validation.py (MIT).
 *  - Trade-count penalty: freqtrade MultiMetricHyperOptLoss (GPLv3 — formula only; target
 *    30 trades here instead of 50, sized for a 27-day 5-minute window).
 *  - Verdict with an explicit "insufficient" escape hatch: TradingAgents research-manager
 *    judge ("Hold when the evidence is balanced or insufficient").
 */

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// Deterministic PRNG (mulberry32) so p-values are reproducible under a seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toMs = (t) => {
  if (t == null) return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
};
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const stdev = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
};
const round = (x, d = 4) => (x == null || !Number.isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;

// Largest peak-to-trough fall of the cumulative P&L. Returns the drawdown (≥ 0) and the
// cumulative P&L at the peak it fell from (needed for a percent-of-account figure).
export function maxDrawdownOf(pnls) {
  let cum = 0, peak = 0, dd = 0, peakAt = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const fall = peak - cum;
    if (fall > dd) { dd = fall; peakAt = peak; }
  }
  return { maxDrawdown: dd, peakCum: peakAt };
}

// Per-trade return series: pnlPct when the trade carries one, else pnl / initialCapital.
function returnsOf(trades, initialCapital) {
  if (trades.length && trades.every((t) => typeof t.pnlPct === 'number')) return trades.map((t) => t.pnlPct / 100);
  if (initialCapital > 0) return trades.map((t) => (t.pnl || 0) / initialCapital);
  return null;
}

function yearsSpanned(trades) {
  const ts = trades.flatMap((t) => [toMs(t.entryTime), toMs(t.exitTime)]).filter((x) => x != null);
  if (ts.length < 2) return null;
  const span = Math.max(...ts) - Math.min(...ts);
  return span > 0 ? span / MS_PER_YEAR : null;
}

// Annualised trade-based Sharpe: mean/std of per-trade returns × √(trades per year) —
// the freqtrade `calculate_sharpe` convention. `tradesPerYear` is passed so bootstrap and
// permutation samples annualise with the same factor as the observed statistic.
export function sharpeOf(returns, tradesPerYear) {
  const sd = stdev(returns), m = mean(returns);
  // float noise on an identical series yields sd ≈ 1e-19, not 0 — treat that as no variance
  if (sd == null || sd <= Math.abs(m) * 1e-9 || sd === 0) return null;
  return m / sd * Math.sqrt(tradesPerYear || 1);
}
export function sortinoOf(returns, tradesPerYear) {
  if (returns.length < 2) return null;
  const down = Math.sqrt(returns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / returns.length), m = mean(returns);
  if (down <= Math.abs(m) * 1e-9 || down === 0) return null;
  return m / down * Math.sqrt(tradesPerYear || 1);
}
function profitFactorOf(pnls) {
  let gp = 0, gl = 0;
  for (const p of pnls) { if (p > 0) gp += p; else gl += p; }
  if (gl === 0) return gp > 0 ? null : null; // undefined (no losers) — reported as null
  return gp / Math.abs(gl);
}

function sideStats(ts) {
  const n = ts.length, wins = ts.filter((t) => t.pnl > 0).length;
  return { trades: n, netProfit: round(ts.reduce((a, t) => a + (t.pnl || 0), 0), 2), winRate: n ? round(100 * wins / n, 2) : null };
}

/**
 * Metrics from a trade list. Money in the strategy's account currency; percentages are plain
 * numbers (4.81 means 4.81 %). Drawdown is closed-trade (TradingView's includes open P&L bar
 * by bar, so the two are expected to differ slightly).
 */
export function computeMetrics(trades, { initialCapital = null } = {}) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  const n = ts.length;
  if (!n) return { totalTrades: 0, netProfit: 0, netProfitPct: null, winRate: null, profitFactor: null, maxDrawdown: 0, maxDrawdownPct: null, avgTrade: null, avgTradePct: null, avgWin: null, avgLoss: null, expectancy: null, expectancyRatio: null, sharpe: null, sortino: null, calmar: null, maxConsecLosses: 0, maxConsecWins: 0, grossProfit: 0, grossLoss: 0, tradesPerYear: null, long: sideStats([]), short: sideStats([]) };
  const pnls = ts.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0), grossLoss = losses.reduce((a, b) => a + b, 0);
  const netProfit = grossProfit + grossLoss + pnls.filter((p) => p === 0).length * 0;
  const { maxDrawdown, peakCum } = maxDrawdownOf(pnls);
  const winRate = wins.length / n;
  const avgWin = wins.length ? mean(wins) : null, avgLoss = losses.length ? mean(losses) : null;
  const expectancy = (avgWin ?? 0) * winRate + (avgLoss ?? 0) * (1 - winRate);
  const years = yearsSpanned(ts);
  const tradesPerYear = years ? n / years : null;
  const rets = returnsOf(ts, initialCapital);
  const sharpe = rets && tradesPerYear ? sharpeOf(rets, tradesPerYear) : null;
  const sortino = rets && tradesPerYear ? sortinoOf(rets, tradesPerYear) : null;
  const netProfitPct = initialCapital > 0 ? 100 * netProfit / initialCapital
    : (ts.every((t) => typeof t.pnlPct === 'number') ? ts.reduce((a, t) => a + t.pnlPct, 0) : null);
  const maxDrawdownPct = initialCapital > 0 ? 100 * maxDrawdown / (initialCapital + peakCum) : null;
  const annualizedReturnPct = netProfitPct != null && years ? netProfitPct / years : null;
  const calmar = annualizedReturnPct != null && maxDrawdownPct > 0 ? annualizedReturnPct / maxDrawdownPct : null;
  let consecL = 0, maxConsecLosses = 0, consecW = 0, maxConsecWins = 0;
  for (const p of pnls) {
    if (p < 0) { consecL++; consecW = 0; } else if (p > 0) { consecW++; consecL = 0; } else { consecL = 0; consecW = 0; }
    if (consecL > maxConsecLosses) maxConsecLosses = consecL;
    if (consecW > maxConsecWins) maxConsecWins = consecW;
  }
  return {
    totalTrades: n,
    netProfit: round(netProfit, 2), netProfitPct: round(netProfitPct, 2),
    winRate: round(100 * winRate, 2), profitFactor: round(profitFactorOf(pnls), 3),
    maxDrawdown: round(maxDrawdown, 2), maxDrawdownPct: round(maxDrawdownPct, 2),
    avgTrade: round(netProfit / n, 2), avgTradePct: ts.every((t) => typeof t.pnlPct === 'number') ? round(mean(ts.map((t) => t.pnlPct)), 3) : null,
    avgWin: round(avgWin, 2), avgLoss: round(avgLoss, 2),
    expectancy: round(expectancy, 2), expectancyRatio: avgLoss ? round(expectancy / Math.abs(avgLoss), 3) : null,
    sharpe: round(sharpe, 3), sortino: round(sortino, 3), calmar: round(calmar, 3),
    maxConsecLosses, maxConsecWins,
    grossProfit: round(grossProfit, 2), grossLoss: round(grossLoss, 2), tradesPerYear: round(tradesPerYear, 1),
    long: sideStats(ts.filter((t) => t.side === 'long')), short: sideStats(ts.filter((t) => t.side === 'short')),
  };
}

export function windowOf(trades) {
  const ts = (trades || []).filter(Boolean);
  const first = ts.map((t) => toMs(t.entryTime)).filter((x) => x != null), last = ts.map((t) => toMs(t.exitTime)).filter((x) => x != null);
  return {
    firstTradeTime: first.length ? new Date(Math.min(...first)).toISOString() : null,
    lastTradeTime: last.length ? new Date(Math.max(...last)).toISOString() : null,
    tradeCount: ts.length,
  };
}

/** IS = trades that closed before splitDate; OOS = the rest. */
export function splitByDate(trades, splitDate, opts = {}) {
  const cut = toMs(splitDate);
  if (cut == null) return null;
  const is = [], oos = [];
  for (const t of trades) ((toMs(t.exitTime) ?? 0) < cut ? is : oos).push(t);
  const pick = (m) => ({ n: m.totalTrades, netProfit: m.netProfit, netProfitPct: m.netProfitPct, profitFactor: m.profitFactor, sharpe: m.sharpe, maxDrawdown: m.maxDrawdown });
  return { splitDate: new Date(cut).toISOString(), is: pick(computeMetrics(is, opts)), oos: pick(computeMetrics(oos, opts)) };
}

/**
 * Monte-Carlo checks on the same trades:
 *  - pSharpe / pProfitFactor: sign-flip permutation test. Under "no edge" each trade's
 *    return is as likely negative as positive; p = share of flipped samples whose statistic
 *    is at least as good as observed (add-one smoothed). Order shuffles cannot move a
 *    per-trade Sharpe, which is why signs are flipped instead of positions.
 *  - pMaxDD: order-shuffle test. p = share of random orderings whose max drawdown is at
 *    least as large as observed — a HIGH value means the historical sequence was gentler
 *    than most orderings of the same trades (expect worse); a LOW value means it was unusually
 *    harsh.
 */
export function monteCarloPermutation(trades, { n = 1000, seed = 42, initialCapital = null } = {}) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  if (ts.length < 3) return { n, seed, samples: 0, pSharpe: null, pMaxDD: null, pProfitFactor: null };
  const rets = returnsOf(ts, initialCapital) || ts.map((t) => t.pnl);
  const pnls = ts.map((t) => t.pnl);
  const years = yearsSpanned(ts), tpy = years ? ts.length / years : 1;
  const obsSharpe = sharpeOf(rets, tpy), obsPF = profitFactorOf(pnls), obsDD = maxDrawdownOf(pnls).maxDrawdown;
  const rnd = mulberry32(seed);
  let geS = 0, gePF = 0, geDD = 0;
  const flipped = new Array(rets.length), flippedP = new Array(pnls.length), order = pnls.slice();
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < rets.length; i++) { const s = rnd() < 0.5 ? -1 : 1; flipped[i] = rets[i] * s; flippedP[i] = pnls[i] * s; }
    const sh = sharpeOf(flipped, tpy);
    if (obsSharpe != null && sh != null && sh >= obsSharpe) geS++;
    const pf = profitFactorOf(flippedP);
    if (obsPF != null && (pf == null || pf >= obsPF)) gePF++;
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
    if (maxDrawdownOf(order).maxDrawdown >= obsDD) geDD++;
  }
  const p = (c) => round((c + 1) / (n + 1), 4);
  return { n, seed, samples: ts.length, pSharpe: obsSharpe == null ? null : p(geS), pMaxDD: p(geDD), pProfitFactor: obsPF == null ? null : p(gePF), observed: { sharpe: round(obsSharpe, 3), profitFactor: round(obsPF, 3), maxDrawdown: round(obsDD, 2) } };
}

/** Bootstrap (resample with replacement) confidence interval for the annualised Sharpe. */
export function bootstrapSharpeCI(trades, { n = 1000, conf = 0.95, seed = 42, initialCapital = null } = {}) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  if (ts.length < 3) return { n, conf, seed, sharpeLo: null, sharpeHi: null, pPositive: null };
  const rets = returnsOf(ts, initialCapital) || ts.map((t) => t.pnl);
  const years = yearsSpanned(ts), tpy = years ? ts.length / years : 1;
  const rnd = mulberry32(seed + 1);
  const out = []; let pos = 0;
  const sample = new Array(rets.length);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < rets.length; i++) sample[i] = rets[Math.floor(rnd() * rets.length)];
    const sh = sharpeOf(sample, tpy);
    if (sh != null) out.push(sh);
    if (mean(sample) > 0) pos++;
  }
  out.sort((a, b) => a - b);
  const lo = out[Math.floor((1 - conf) / 2 * out.length)], hi = out[Math.min(out.length - 1, Math.floor((1 + conf) / 2 * out.length))];
  return { n, conf, seed, sharpeLo: round(lo, 3), sharpeHi: round(hi, 3), pPositive: round(pos / n, 4), observed: round(sharpeOf(rets, tpy), 3) };
}

/** Consecutive equal-count windows over the trade list; stable when ≥ 3 of 5 are positive. */
export function walkForwardWindows(trades, { nWindows = 5, initialCapital = null } = {}) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  const k = Math.max(1, Math.min(nWindows, Math.floor(ts.length / 2)));
  const windows = [];
  for (let w = 0; w < k; w++) {
    const a = Math.floor(w * ts.length / k), b = Math.floor((w + 1) * ts.length / k);
    const slice = ts.slice(a, b);
    if (!slice.length) continue;
    const m = computeMetrics(slice, { initialCapital });
    windows.push({ from: slice[0].entryTime ?? null, to: slice[slice.length - 1].exitTime ?? null, n: slice.length, netProfit: m.netProfit, profitFactor: m.profitFactor });
  }
  const positive = windows.filter((w) => w.netProfit > 0).length;
  const positiveFraction = windows.length ? round(positive / windows.length, 3) : null;
  return { nWindows: windows.length, windows, positiveFraction, stable: windows.length ? positive / windows.length >= 0.6 : false };
}

/** 1 when n ≥ target, else max(0.1, 1 − |n − target| / target). */
export function tradeCountPenalty(n, { target = 30 } = {}) {
  if (n >= target) return 1;
  return Math.max(0.1, 1 - Math.abs(n - target) / target);
}

/**
 * Deterministic verdict. `insufficient` beats everything: fewer than minTrades trades, an
 * unsettled run, or (sweeps) too few settled runs. `edge` needs a significant sign-flip
 * Sharpe, a positive out-of-sample profit factor when a split exists, and (sweeps) an
 * objective better than baseline. Everything else is `noise`.
 */
export function verdictOf({ n = 0, settled = true, pSharpe = null, oos = null, objectiveBetter = null, settledRuns = null, minTrades = 30, minSettledRuns = 8 } = {}) {
  const reasons = [];
  if (n < minTrades) reasons.push(`only ${n} trades (< ${minTrades})`);
  if (!settled) reasons.push('tester did not settle');
  if (settledRuns != null && settledRuns < minSettledRuns) reasons.push(`only ${settledRuns} settled runs (< ${minSettledRuns})`);
  if (reasons.length) return { verdict: 'insufficient', reasons };
  const sig = pSharpe != null && pSharpe < 0.05;
  reasons.push(sig ? `pSharpe ${pSharpe} < 0.05` : `pSharpe ${pSharpe ?? 'n/a'} ≥ 0.05`);
  let oosOk = true;
  if (oos) {
    oosOk = oos.profitFactor != null && oos.profitFactor > 1 && oos.netProfit > 0;
    reasons.push(oosOk ? `OOS profit factor ${oos.profitFactor} > 1` : `OOS profit factor ${oos.profitFactor ?? 'n/a'} (${oos.n ?? 0} trades) fails`);
  }
  let better = true;
  if (objectiveBetter != null) { better = !!objectiveBetter; reasons.push(better ? 'objective beats baseline' : 'objective does not beat baseline'); }
  return { verdict: sig && oosOk && better ? 'edge' : 'noise', reasons };
}

/** Full ValidationResult for one run. */
export function validate(trades, { splitDate = null, initialCapital = null, settled = true, mc = {}, nWindows = 5 } = {}) {
  const ts = (trades || []).filter((t) => t && typeof t.pnl === 'number');
  const split = splitDate ? splitByDate(ts, splitDate, { initialCapital }) : null;
  const monteCarlo = monteCarloPermutation(ts, { initialCapital, ...mc });
  const bootstrap = bootstrapSharpeCI(ts, { initialCapital, ...mc });
  const walkForward = walkForwardWindows(ts, { nWindows, initialCapital });
  const penalty = tradeCountPenalty(ts.length);
  const v = verdictOf({ n: ts.length, settled, pSharpe: monteCarlo.pSharpe, oos: split ? split.oos : null });
  return { split, monteCarlo, bootstrap, walkForward, tradeCountPenalty: penalty, verdict: v.verdict, reasons: v.reasons };
}
