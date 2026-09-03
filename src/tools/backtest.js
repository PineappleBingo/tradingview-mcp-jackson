import { z } from 'zod';
import { jsonResult } from './_format.js';
import { runBacktest } from '../core/backtest.js';

export function registerBacktestTools(server) {
  server.tool('strategy_run_backtest', 'Run ONE reproducible backtest on the live Strategy Tester and return a RunCard: applies optional input overrides (ids like in_3 from data_get_indicator), waits until the tester settles (signature changed then stable), reads report + trades + equity in one snapshot, normalizes metrics with per-key provenance (tv/computed/both), and validates (IS/OOS split, Monte-Carlo, bootstrap, walk-forward, verdict edge|noise|insufficient). Prefer this over data_get_strategy_results + data_get_trades when you need trustworthy numbers.', {
    config: z.string().optional().describe('JSON RunConfig {study:{name}, inputs:{in_N:value}, labels, restore, settle:{pollMs,stablePolls,timeoutMs}, splitDate, costs:{initialCapital,commissionPct}}'),
    inputs: z.string().optional().describe('JSON input overrides, e.g. \'{"in_12": "Hard Filter"}\' (merged into config.inputs)'),
    study_filter: z.string().optional().describe('Case-insensitive substring of the strategy study name (default PineForge|PF 3G)'),
    split_date: z.string().optional().describe('ISO date; trades closed before it are in-sample, the rest out-of-sample'),
    restore: z.coerce.boolean().optional().describe('Restore the original inputs after reading (default false for a single run)'),
    settle_timeout_ms: z.coerce.number().optional().describe('Max wait for the tester to settle (default 15000, max 60000)'),
    initial_capital: z.coerce.number().optional().describe('Account size used for percent metrics when the report does not carry them'),
  }, async ({ config, inputs, study_filter, split_date, restore, settle_timeout_ms, initial_capital }) => {
    try {
      let c = {};
      if (config) { try { c = JSON.parse(config); } catch { return jsonResult({ success: false, error: 'config must be valid JSON' }, true); } }
      if (inputs) { let o; try { o = JSON.parse(inputs); } catch { return jsonResult({ success: false, error: 'inputs must be valid JSON' }, true); } c.inputs = { ...(c.inputs || {}), ...o }; }
      if (study_filter) c.study = { ...(c.study || {}), name: study_filter };
      if (split_date) c.splitDate = split_date;
      if (restore !== undefined) c.restore = restore;
      if (settle_timeout_ms) c.settle = { ...(c.settle || {}), timeoutMs: settle_timeout_ms };
      if (initial_capital) c.costs = { ...(c.costs || {}), initialCapital: initial_capital };
      return jsonResult(await runBacktest(c));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
