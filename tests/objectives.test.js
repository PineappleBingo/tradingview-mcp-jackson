import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECTIVES, list, score, DEFAULT_OBJECTIVE, DRAWDOWN_MULT } from '../src/core/objectives.js';

const M = { netProfit: 100, netProfitPct: 1, totalTrades: 40, winRate: 55, profitFactor: 1.5, maxDrawdown: 25, maxDrawdownPct: 2.5, expectancyRatio: 0.4, sharpe: 1.2, sortino: 1.8, calmar: 3, grossProfit: 300, grossLoss: -200 };

test('registry: eight objectives, multi_metric default, list() shape', () => {
  assert.deepEqual(Object.keys(OBJECTIVES), ['only_profit', 'profit_factor', 'sharpe', 'sortino', 'calmar', 'max_drawdown_ratio', 'profit_drawdown', 'multi_metric']);
  assert.equal(DEFAULT_OBJECTIVE, 'multi_metric');
  assert.equal(list().filter((o) => o.default).length, 1);
  assert.throws(() => score('nope', M), /unknown objective/);
});

test('formulas (smaller is better)', () => {
  assert.equal(score('only_profit', M), -100);
  assert.equal(score('profit_factor', M), -1.5);
  assert.equal(score('profit_factor', { ...M, profitFactor: 40 }), -10, 'capped at 10');
  assert.equal(score('sharpe', M), -1.2); assert.equal(score('sortino', M), -1.8); assert.equal(score('calmar', M), -3);
  assert.equal(score('max_drawdown_ratio', M), -4);
  assert.equal(score('max_drawdown_ratio', { ...M, maxDrawdown: 0 }), -100);
  const pd = 100 - 0.025 * 100 * (1 - DRAWDOWN_MULT);
  assert.equal(score('profit_drawdown', M), -Math.round(pd * 1e6) / 1e6);
  const mm = -(pd * Math.log(2.5) * Math.log(2.4) * Math.log(1.75) * 1);
  assert.equal(score('multi_metric', M), Math.round(mm * 1e6) / 1e6);
});

test('multi_metric penalises few trades, tolerates missing PF via gross figures, null when profit missing', () => {
  const few = score('multi_metric', { ...M, totalTrades: 10 }), full = score('multi_metric', M);
  assert.ok(few > full, 'fewer trades → worse (larger) loss');
  const noPf = score('multi_metric', { ...M, profitFactor: null });
  assert.equal(noPf, full, 'profit factor recomputed from gross profit/loss');
  assert.equal(score('multi_metric', { totalTrades: 5 }), null);
  assert.equal(score('only_profit', null), null);
});

test('monotonic: more net profit never scores worse', () => {
  for (const name of Object.keys(OBJECTIVES)) {
    if (['sharpe', 'sortino', 'calmar', 'profit_factor'].includes(name)) continue;
    assert.ok(score(name, { ...M, netProfit: 200 }) <= score(name, M), name);
  }
});
