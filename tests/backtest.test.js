/**
 * Phase 3 backtest runner (src/core/backtest.js) + settle wait (src/wait.js) with fake deps — no CDP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeConfig, configHash, mapTrades, tvMetrics, normalizeMetrics, renderRunCardMd, runBacktest, snapshotJS,
} from '../src/core/backtest.js';
import { waitForTesterSettle, sigKey, TESTER_SIGNATURE_JS } from '../src/wait.js';
import { registerBacktestTools } from '../src/tools/backtest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1787716800; // seconds, 2026-08-26T04:00:00Z
const orders = Array.from({ length: 40 }, (_, i) => ({
  entry_type: i % 4 === 0 ? 'Entry Short' : 'Entry Long', entry_time: T0 + i * 3600, exit_time: T0 + i * 3600 + 1800,
  entry_price: 100, exit_price: 101, qty: 1, profit: i % 3 === 0 ? -8 : 12, profit_percent: i % 3 === 0 ? -0.8 : 1.2,
}));
const sum = orders.reduce((a, o) => a + o.profit, 0);
const reportData = { netProfit: { all: sum, long: 300, short: 60 }, totalTrades: { all: 40 }, percentProfitable: { all: 26 / 40 },
  profitFactor: { all: (27 * 12) / (13 * 8) }, maxStrategyDrawDown: { all: 8 }, avgTrade: { all: sum / 40 }, sharpeRatio: 1.7 };

function fakeDeps(over = {}) {
  const calls = [];
  const sigs = [{ found: true, tradeCount: 39, lastKey: 'a', netProfit: 1, totalTrades: 39 }, { found: true, tradeCount: 40, lastKey: 'b', netProfit: sum, totalTrades: 40 }];
  return {
    calls,
    deps: {
      getChartState: async () => { calls.push('getChartState'); return { success: true, symbol: 'COINBASE:SOLUSD', resolution: '5', studies: [{ id: 'x1', name: 'Volume' }, { id: 'pf1', name: 'PineForge 3rd Gen Volume Profile Strategy [Coinbase]' }] }; },
      getIndicator: async ({ entity_id }) => { calls.push('getIndicator:' + entity_id); return { success: true, inputs: [{ id: 'in_3', value: 'Soft Filter' }, { id: 'in_7', value: 0.25 }] }; },
      setInputs: async ({ entity_id, inputs }) => { calls.push('setInputs:' + JSON.stringify(inputs)); return { success: true, entity_id, updated_inputs: inputs }; },
      testerSignature: async () => { calls.push('signature'); return sigs[0]; },
      waitForTesterSettle: async (o) => { calls.push('settle:' + JSON.stringify([o.pollMs, o.stablePolls, o.timeoutMs])); return { settled: true, settleMs: 1234 }; },
      readStrategySnapshot: async () => { calls.push('snapshot'); return { reportData, orders, ordersTotal: 40, equity: { points: [{ t: T0, equity: 10000, dd: 0 }, { t: T0 + 100, equity: 10010, dd: 0 }], total: 2, downsampled: false } }; },
      now: () => 1000,
      ...over,
    },
  };
}

test('normalizeConfig: defaults, clamps, JSON string input', () => {
  const c = normalizeConfig('{"inputs":{"in_3":"Hard Filter"},"settle":{"timeoutMs":999999,"pollMs":1},"restore":"yes"}');
  assert.deepEqual(c.inputs, { in_3: 'Hard Filter' });
  assert.equal(c.settle.timeoutMs, 60000); assert.equal(c.settle.pollMs, 50); assert.equal(c.settle.stablePolls, 3);
  assert.equal(c.restore, true); assert.equal(c.splitDate, null); assert.equal(c.costs, null);
  assert.throws(() => normalizeConfig('{nope'), /valid JSON/);
});

test('configHash ignores entityId and key order, changes with an input', () => {
  const a = configHash({ study: { entityId: 'A', name: 'PF' }, symbol: 'X', timeframe: '5', inputs: { in_3: 1, in_2: 2 } });
  const b = configHash({ inputs: { in_2: 2, in_3: 1 }, timeframe: '5', symbol: 'X', study: { name: 'PF', entityId: 'B' } });
  assert.equal(a, b);
  assert.notEqual(a, configHash({ study: { name: 'PF' }, symbol: 'X', timeframe: '5', inputs: { in_3: 2, in_2: 2 } }));
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('mapTrades: seconds→ISO, side words, sorted, cumulative P&L', () => {
  const t = mapTrades([{ entry_time: T0 + 60, exit_time: T0 + 120, profit: -1, type: 'Short' }, { entryTime: (T0) * 1000, exitTime: (T0 + 30) * 1000, pnl: 5, direction: 'buy' }]);
  assert.equal(t.length, 2);
  assert.equal(t[0].n, 1); assert.equal(t[0].side, 'long'); assert.equal(t[0].entryTime, '2026-08-26T04:00:00.000Z'); assert.equal(t[0].cumPnl, 5);
  assert.equal(t[1].side, 'short'); assert.equal(t[1].cumPnl, 4);
});

test('tvMetrics unwraps {all,long,short}, converts fractional win rate, signs avgLoss', () => {
  const m = tvMetrics({ ...reportData, avgLosTrade: { all: 8 } });
  assert.equal(m.metrics.netProfit, sum); assert.equal(m.long.netProfit, 300);
  assert.equal(m.metrics.winRate, 65); assert.equal(m.metrics.avgLoss, -8); assert.equal(m.metrics.sharpe, 1.7);
  assert.deepEqual(tvMetrics(null).metrics, {});
});

test('normalizeMetrics: both when TV and computed agree, mismatch warning when they do not, single-source otherwise', () => {
  const trades = mapTrades(orders);
  const ok = normalizeMetrics(reportData, trades, { initialCapital: 10000 });
  assert.equal(ok.metricSources.netProfit, 'both');
  assert.equal(ok.metricSources.totalTrades, 'both');
  assert.equal(ok.metricSources.winRate, 'both');
  assert.equal(ok.metricSources.profitFactor, 'both');
  assert.equal(ok.metricSources.sharpe, 'tv', 'TV-only value is kept with its source');
  assert.equal(ok.metricSources.calmar, 'computed');
  assert.ok(!ok.warnings.some((w) => w.startsWith('metrics_mismatch')), ok.warnings.join(','));
  const bad = normalizeMetrics({ ...reportData, netProfit: { all: sum + 100 } }, trades, { initialCapital: 10000 });
  assert.deepEqual(bad.warnings.filter((w) => w.startsWith('metrics_mismatch')), ['metrics_mismatch:netProfit']);
  assert.equal(bad.metrics.netProfit, sum + 100, 'TV value wins, the recomputation is the audit');
  assert.ok(normalizeMetrics({}, trades.slice(0, 5), null).warnings.includes('few_trades'));
});

test('runBacktest: resolves the PF study, applies only changed inputs, waits, snapshots, validates, restores', async () => {
  const { calls, deps } = fakeDeps();
  const r = await runBacktest({ inputs: { in_3: 'Hard Filter', in_7: 0.25 }, restore: true, splitDate: '2026-08-27T00:00:00Z', costs: { initialCapital: 10000 } }, deps);
  assert.equal(r.success, true, JSON.stringify(r));
  const c = r.card;
  assert.equal(c.config.study.entityId, 'pf1');
  assert.equal(c.config.symbol, 'COINBASE:SOLUSD'); assert.equal(c.config.timeframe, '5');
  assert.match(c.config.configHash, /^[0-9a-f]{40}$/);
  assert.deepEqual(calls, ['getChartState', 'getIndicator:pf1', 'signature', 'setInputs:{"in_3":"Hard Filter"}', 'settle:[250,3,15000]', 'snapshot', 'setInputs:{"in_3":"Soft Filter"}']);
  assert.equal(c.settled, true); assert.equal(c.settleMs, 1234);
  assert.equal(c.trades.length, 40); assert.equal(c.window.tradeCount, 40);
  assert.equal(c.metrics.totalTrades, 40); assert.equal(c.metricSources.netProfit, 'both');
  assert.ok(c.validation.split && c.validation.split.is.n > 0 && c.validation.split.oos.n > 0);
  assert.ok(['edge', 'noise'].includes(c.validation.verdict), c.validation.verdict);
  assert.deepEqual(c.restore, { requested: true, restored: true, changed: ['in_3'], error: null });
  assert.match(c.body_md, /^# Backtest · COINBASE:SOLUSD · 5/);
  assert.match(c.body_md, /Verdict: (EDGE|NOISE)/);
  assert.ok(!c.warnings.includes('unsettled'));
});

test('runBacktest: no_change skips the wait, unknown ids are reported, unsettled is a warning not an error', async () => {
  const same = fakeDeps();
  const r1 = await runBacktest({ inputs: { in_3: 'Soft Filter', in_99: 1 } }, same.deps);
  assert.ok(r1.card.warnings.includes('no_change')); assert.ok(r1.card.warnings.includes('inputs_not_applied:in_99'));
  assert.ok(!same.calls.some((x) => x.startsWith('settle')), 'no settle wait when nothing changes');
  const slow = fakeDeps({ waitForTesterSettle: async () => ({ settled: false, settleMs: 15000 }) });
  const r2 = await runBacktest({ inputs: { in_3: 'Hard Filter' } }, slow.deps);
  assert.equal(r2.success, true); assert.equal(r2.card.settled, false); assert.ok(r2.card.warnings.includes('unsettled'));
  assert.equal(r2.card.validation.verdict, 'insufficient');
});

test('runBacktest: study missing → success:false; restore still runs when the snapshot throws', async () => {
  const none = fakeDeps({ getChartState: async () => ({ studies: [{ id: 'v', name: 'Volume' }] }) });
  const r = await runBacktest({}, none.deps);
  assert.equal(r.success, false); assert.match(r.error, /not found/);
  const boom = fakeDeps({ readStrategySnapshot: async () => { throw new Error('CDP hiccup'); } });
  await assert.rejects(runBacktest({ inputs: { in_3: 'Hard Filter' }, restore: true }, boom.deps), /CDP hiccup/);
  assert.equal(boom.calls[boom.calls.length - 1], 'setInputs:{"in_3":"Soft Filter"}', 'finally restored the original input');
});

test('waitForTesterSettle: settled after the signature changes and holds for stablePolls; timeout returns settled:false', async () => {
  const seq = [{ found: true, tradeCount: 1, lastKey: 'a' }, { found: true, tradeCount: 2, lastKey: 'b' }, { found: true, tradeCount: 2, lastKey: 'b' }, { found: true, tradeCount: 2, lastKey: 'b' }, { found: true, tradeCount: 2, lastKey: 'b' }];
  let i = 0, t = 0;
  const r = await waitForTesterSettle({ before: seq[0], pollMs: 250, stablePolls: 3, timeoutMs: 15000, signature: async () => seq[Math.min(i++, seq.length - 1)], sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(r.settled, true); assert.equal(r.polls, 4); assert.equal(r.settleMs, 1000);
  let t2 = 0;
  const r2 = await waitForTesterSettle({ before: seq[0], pollMs: 250, stablePolls: 3, timeoutMs: 2000, signature: async () => seq[0], sleep: async (ms) => { t2 += ms; }, now: () => t2 });
  assert.equal(r2.settled, false); assert.equal(r2.changed, false); assert.ok(r2.settleMs >= 2000);
  assert.equal(sigKey({ found: false }), 'null');
  assert.match(TESTER_SIGNATURE_JS, /ordersData/);
});

test('snapshot JS embeds the caps and the strategy locate idiom', () => {
  const js = snapshotJS(123, 45);
  assert.match(js, /orders\.length - 123/); assert.match(js, /eq\.length > 45/); assert.match(js, /ordersData \|\| s\.reportData \|\| s\.performance/);
});

test('renderRunCardMd renders verdict, table and trades without throwing on sparse cards', () => {
  const md = renderRunCardMd({ config: { symbol: 'S', timeframe: '5', inputs: {} }, settled: false, metrics: {}, metricSources: {}, validation: { verdict: 'insufficient', reasons: ['only 0 trades (< 30)'] }, trades: [], warnings: ['no_equity'] });
  assert.match(md, /UNSETTLED/); assert.match(md, /Verdict: INSUFFICIENT/); assert.match(md, /Warnings: no_equity/);
});

test('strategy_run_backtest is registered and wired into server + core index', () => {
  const tools = new Map();
  registerBacktestTools({ tool: (name, desc, schema) => tools.set(name, { desc, schema }) });
  assert.ok(tools.has('strategy_run_backtest'));
  assert.deepEqual(Object.keys(tools.get('strategy_run_backtest').schema).sort(), ['config', 'initial_capital', 'inputs', 'restore', 'settle_timeout_ms', 'split_date', 'study_filter']);
  assert.ok(readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8').includes('registerBacktestTools(server)'));
  const idx = readFileSync(path.join(ROOT, 'src', 'core', 'index.js'), 'utf8');
  assert.ok(idx.includes('backtest') && idx.includes('validate'));
});
