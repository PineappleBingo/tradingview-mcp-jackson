/**
 * Pure trust-layer tests (src/core/validate.js) — no TradingView, deterministic under seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics, splitByDate, monteCarloPermutation, bootstrapSharpeCI, walkForwardWindows,
  tradeCountPenalty, verdictOf, validate, maxDrawdownOf, mulberry32,
} from '../src/core/validate.js';

const T0 = Date.UTC(2026, 7, 1); // 2026-08-01
const H = 3600 * 1000;
// One trade every 6 hours over ~3 days: pnl sequence chosen so the numbers are hand-checkable.
const PNL = [10, -5, 20, -5, -5, 15, 30, -10, 5, -20, 25, 10];
const trades = PNL.map((p, i) => ({
  n: i + 1, side: i % 3 === 0 ? 'short' : 'long',
  entryTime: new Date(T0 + i * 6 * H).toISOString(), exitTime: new Date(T0 + i * 6 * H + 2 * H).toISOString(),
  entryPrice: 100, exitPrice: 100 + p / 10, qty: 1, pnl: p, pnlPct: p / 10,
}));

test('computeMetrics: net, win rate, profit factor, drawdown, streaks, sides', () => {
  const m = computeMetrics(trades, { initialCapital: 1000 });
  assert.equal(m.totalTrades, 12);
  assert.equal(m.netProfit, 70);                       // Σ PNL
  assert.equal(m.netProfitPct, 7);                      // 70 / 1000
  assert.equal(m.winRate, 58.33);                       // 7 of 12
  assert.equal(m.grossProfit, 115); assert.equal(m.grossLoss, -45);
  assert.equal(m.profitFactor, 2.556);                  // 115 / 45
  // cumulative: 10,5,25,20,15,30,60,50,55,35,60,70 → peak 60 then 35 → DD 25
  assert.equal(m.maxDrawdown, 25);
  assert.equal(m.maxDrawdownPct, 2.36);                 // 25 / (1000 + 60)
  assert.equal(m.maxConsecLosses, 2);
  assert.equal(m.avgTrade, 5.83);
  assert.equal(m.long.trades, 8); assert.equal(m.short.trades, 4);
  assert.ok(m.sharpe > 0 && m.sortino > 0, 'positive series has positive ratios');
  assert.equal(m.expectancyRatio, 0.648);               // ((115/7)*0.5833 + (-45/5)*0.4167) / 9
});

test('computeMetrics on an empty list is all-null/zero, never NaN', () => {
  const m = computeMetrics([]);
  assert.equal(m.totalTrades, 0); assert.equal(m.netProfit, 0); assert.equal(m.winRate, null); assert.equal(m.profitFactor, null);
  assert.ok(!Object.values(m).some((v) => typeof v === 'number' && Number.isNaN(v)));
});

test('maxDrawdownOf handles a series that never recovers', () => {
  assert.deepEqual(maxDrawdownOf([5, -10, -10]), { maxDrawdown: 20, peakCum: 5 });
  assert.deepEqual(maxDrawdownOf([1, 2, 3]), { maxDrawdown: 0, peakCum: 0 });
});

test('splitByDate splits on exitTime and reports both halves', () => {
  const s = splitByDate(trades, new Date(T0 + 36 * H).toISOString(), { initialCapital: 1000 });
  assert.equal(s.is.n, 6); assert.equal(s.oos.n, 6);
  assert.equal(s.is.netProfit, 30); assert.equal(s.oos.netProfit, 40);
  assert.equal(splitByDate(trades, 'not a date'), null);
});

test('tradeCountPenalty: 1 at/above target, linear below, floored at 0.1', () => {
  assert.equal(tradeCountPenalty(30), 1); assert.equal(tradeCountPenalty(60), 1);
  assert.equal(tradeCountPenalty(15), 0.5);
  assert.equal(tradeCountPenalty(5), Math.max(0.1, 1 - 25 / 30));
  assert.equal(tradeCountPenalty(0), 0.1);
});

test('walkForwardWindows partitions the list and counts positive windows', () => {
  const w = walkForwardWindows(trades, { nWindows: 4 });
  assert.equal(w.nWindows, 4);
  assert.equal(w.windows.reduce((a, x) => a + x.n, 0), 12);
  assert.deepEqual(w.windows.map((x) => x.netProfit), [25, 5, 25, 15]);
  assert.equal(w.positiveFraction, 1); assert.equal(w.stable, true);
  assert.equal(walkForwardWindows(trades.slice(0, 3), { nWindows: 5 }).nWindows, 1, 'at least two trades per window');
});

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(7), b = mulberry32(7);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('monteCarlo: deterministic under seed, small pSharpe for a consistently winning series, ~0.5 for a symmetric one', () => {
  const win = trades.map((t) => ({ ...t, pnl: 10, pnlPct: 1 }));
  const a = monteCarloPermutation(win, { n: 400, seed: 1 }), b = monteCarloPermutation(win, { n: 400, seed: 1 });
  assert.deepEqual(a, b);
  assert.equal(a.observed.sharpe, null, 'zero-variance series has no Sharpe');
  const strong = trades.map((t, i) => ({ ...t, pnl: 10 + (i % 2), pnlPct: 1 + (i % 2) / 10 }));
  const s = monteCarloPermutation(strong, { n: 400, seed: 2 });
  assert.ok(s.pSharpe < 0.05, 'all-positive returns are significant: ' + s.pSharpe);
  assert.ok(s.pProfitFactor < 0.05);
  const sym = trades.map((t, i) => ({ ...t, pnl: i % 2 ? 10 : -10, pnlPct: i % 2 ? 1 : -1 }));
  const p = monteCarloPermutation(sym, { n: 400, seed: 3 });
  assert.ok(p.pSharpe > 0.2 && p.pSharpe < 0.8, 'no-edge series is not significant: ' + p.pSharpe);
  assert.ok(p.pMaxDD > 0 && p.pMaxDD <= 1);
  assert.equal(monteCarloPermutation(trades.slice(0, 2)).pSharpe, null, 'too few trades → null');
});

test('bootstrapSharpeCI brackets the observed Sharpe and reports P(mean>0)', () => {
  const b = bootstrapSharpeCI(trades, { n: 500, seed: 4, initialCapital: 1000 });
  assert.ok(b.sharpeLo <= b.observed && b.observed <= b.sharpeHi, JSON.stringify(b));
  assert.ok(b.pPositive > 0.5);
});

test('verdictOf: insufficient beats everything; edge needs significance, OOS and baseline', () => {
  assert.equal(verdictOf({ n: 10, pSharpe: 0.001 }).verdict, 'insufficient');
  assert.equal(verdictOf({ n: 40, settled: false, pSharpe: 0.001 }).verdict, 'insufficient');
  assert.equal(verdictOf({ n: 40, settledRuns: 3, pSharpe: 0.001 }).verdict, 'insufficient');
  assert.equal(verdictOf({ n: 40, pSharpe: 0.01 }).verdict, 'edge');
  assert.equal(verdictOf({ n: 40, pSharpe: 0.3 }).verdict, 'noise');
  assert.equal(verdictOf({ n: 40, pSharpe: 0.01, oos: { n: 10, profitFactor: 0.8, netProfit: -5 } }).verdict, 'noise');
  assert.equal(verdictOf({ n: 40, pSharpe: 0.01, oos: { n: 10, profitFactor: 1.4, netProfit: 5 } }).verdict, 'edge');
  assert.equal(verdictOf({ n: 40, pSharpe: 0.01, objectiveBetter: false }).verdict, 'noise');
  const r = verdictOf({ n: 40, pSharpe: 0.01, oos: { n: 10, profitFactor: 1.4, netProfit: 5 }, objectiveBetter: true });
  assert.equal(r.reasons.length, 3);
});

test('validate composes split, Monte-Carlo, bootstrap, walk-forward, penalty and verdict', () => {
  const v = validate(trades, { splitDate: new Date(T0 + 36 * H).toISOString(), initialCapital: 1000, mc: { n: 200, seed: 9 } });
  assert.equal(v.split.is.n, 6);
  assert.equal(v.monteCarlo.n, 200);
  assert.equal(v.walkForward.nWindows, 5);
  assert.equal(v.tradeCountPenalty, tradeCountPenalty(12));
  assert.equal(v.verdict, 'insufficient', '12 trades < 30');
  assert.match(v.reasons[0], /only 12 trades/);
});
