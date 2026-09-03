import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, rank, stabilityOf, selectAndVerdict, decisionResolvedBy, realizedFor, matrixOf, compact } from '../src/core/sweep.js';
import { normalizeSpace, expandGrid } from '../src/core/paramspace.js';

const T0 = Date.UTC(2026, 7, 1);
const mkCard = (inputs, net, { settled = true, pSharpe = 0.01, n = 40 } = {}) => {
  const trades = Array.from({ length: n }, (_, i) => ({ n: i + 1, side: 'long', entryTime: new Date(T0 + i * 3600e3).toISOString(), exitTime: new Date(T0 + i * 3600e3 + 1800e3).toISOString(), pnl: (i % 4 === 0 ? -6 : 8) + net / n, pnlPct: 0.1 }));
  const netP = trades.reduce((a, t) => a + t.pnl, 0);
  return { config: { inputs, configHash: 'h' + JSON.stringify(inputs).length + net }, settled, settleMs: 100, warnings: [], window: { lastTradeTime: trades[n - 1].exitTime, tradeCount: n },
    metrics: { netProfit: netP, netProfitPct: netP / 100, totalTrades: n, winRate: 75, profitFactor: 2, maxDrawdown: 10, maxDrawdownPct: 1, expectancyRatio: 0.8, sharpe: 2, sortino: 3, calmar: 4, maxConsecLosses: 1, grossProfit: 300, grossLoss: -100 },
    trades, validation: { monteCarlo: { pSharpe }, verdict: 'edge', split: null } };
};
const space = normalizeSpace({ params: [{ id: 'g', label: 'Gate', values: ['Soft', 'Hard'] }, { id: 'e', label: 'ER', type: 'decimal', min: 0.2, max: 0.35, step: 0.05 }] });
const grid = expandGrid(space);
// objective landscape: a smooth ridge peaking at Hard·0.30 with a lonely spike at Soft·0.20
const NET = { 'Soft|0.2': 260, 'Soft|0.25': 20, 'Soft|0.3': 30, 'Soft|0.35': -10, 'Hard|0.2': 150, 'Hard|0.25': 220, 'Hard|0.3': 240, 'Hard|0.35': 230 };
const results = grid.map((inputs, index) => summarizeRun(mkCard(inputs, NET[inputs.g + '|' + inputs.e]), { index, inputs, objective: 'only_profit' }));

test('summarizeRun compacts metrics, computes the objective and an OOS block from a split date', () => {
  const r = summarizeRun(mkCard({ g: 'Hard' }, 100), { index: 0, objective: 'only_profit', splitDate: new Date(T0 + 20 * 3600e3).toISOString() });
  assert.ok(r.oos && r.oos.n === 20 && r.oos.netProfit != null);
  assert.equal(r.isMetrics.totalTrades, 20);
  assert.equal(typeof r.objective, 'number'); assert.equal(r.pSharpe, 0.01);
  assert.deepEqual(Object.keys(compact({})).length, 15);
});

test('rank puts null objectives last', () => {
  const rs = [{ objective: 3 }, { objective: null }, { objective: -2 }];
  assert.deepEqual(rank(rs), [2, 0, 1]);
});

test('stability is the mean objective of the nearest evaluated neighbours', () => {
  const iSpike = results.findIndex((r) => r.inputs.g === 'Soft' && r.inputs.e === 0.2);
  const iRidge = results.findIndex((r) => r.inputs.g === 'Hard' && r.inputs.e === 0.3);
  assert.ok(stabilityOf(results, iSpike, space) > stabilityOf(results, iRidge, space), 'the spike has worse neighbours than the ridge');
});

test('selectAndVerdict prefers the plateau centre over the isolated peak and explains it', () => {
  const sel = selectAndVerdict(results, { space, baseline: { objective: 0 } });
  const chosen = results[sel.selectedIndex].inputs;
  assert.deepEqual(chosen, { g: 'Hard', e: 0.3 }, JSON.stringify(sel));
  assert.notEqual(sel.ranked[0], sel.selectedIndex, 'the raw peak (Soft·0.20) was ranked first but not selected');
  assert.equal(sel.verdict, 'edge'); assert.ok(sel.reasons.some((r) => /plateau/.test(r)));
  assert.equal(sel.settledRuns, 8);
});

test('verdict: insufficient when fewer than 8 settled runs or the selected run is unsettled; noise when baseline is better', () => {
  const few = selectAndVerdict(results.slice(0, 5), { space });
  assert.equal(few.verdict, 'insufficient'); assert.match(few.reasons[0], /settled runs/);
  const worse = selectAndVerdict(results, { space, baseline: { objective: -9999 } });
  assert.equal(worse.verdict, 'noise'); assert.ok(worse.reasons.some((r) => /does not beat baseline/.test(r)));
  const uns = results.map((r) => ({ ...r, settled: false }));
  assert.equal(selectAndVerdict(uns, { space }).verdict, 'insufficient');
  assert.equal(selectAndVerdict(results.map((r) => ({ ...r, objective: null })), { space }).selectedIndex, null);
});

test('decisions resolve only for the same configHash with a later window; realized figures cover the new trades', () => {
  const card = mkCard({ g: 'Hard' }, 100, { n: 50 });
  const d = { status: 'pending', configHash: card.config.configHash, lastTradeTime: new Date(T0 + 40 * 3600e3).toISOString() };
  assert.equal(decisionResolvedBy(d, card), true);
  assert.equal(decisionResolvedBy({ ...d, configHash: 'other' }, card), false);
  assert.equal(decisionResolvedBy({ ...d, lastTradeTime: card.window.lastTradeTime }, card), false);
  assert.equal(decisionResolvedBy({ ...d, status: 'resolved' }, card), false);
  const r = realizedFor(d, card);
  assert.equal(r.n, 10); assert.equal(r.to, card.window.lastTradeTime);
});

test('matrixOf builds a rows×cols grid for exactly two parameters', () => {
  const m = matrixOf(results, space);
  assert.equal(m.rows.length, 2); assert.equal(m.cols.length, 4);
  assert.equal(m.cells[1][2].objective, results.find((r) => r.inputs.g === 'Hard' && r.inputs.e === 0.3).objective);
  assert.equal(matrixOf(results, normalizeSpace({ params: [{ id: 'g', values: ['a', 'b'] }] })), null);
});
