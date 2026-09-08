import { z } from 'zod';
import { jsonResult } from './_format.js';
import { runBacktest } from '../core/backtest.js';
import { normalizeSpace, planSpace, expandGrid, sampleRandom, halvingPlan, resolveLabels, seedFromMeta } from '../core/paramspace.js';
import { list as listObjectives } from '../core/objectives.js';
import { loadProfile } from '../core/gateAudit.js';

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

  server.tool('strategy_sweep_plan', 'Plan a parameter sweep WITHOUT running it: normalizes a ParamSpace (typed, finite; ≤ 64 evaluations), returns the evaluation count, a time estimate and the first points. Build the space either from explicit params [{id:"in_N", type, values|min/max/step}], or from the profile shortlist (labels) plus the study metaInfo inputs you got from ui_evaluate. The sweep itself runs as a bridge job (POST /sweep) so it survives page reloads and can resume.', {
    space: z.string().optional().describe('JSON ParamSpace {params:[{id,label,type,values|min,max,step}], sampler:{kind:grid|random|halving,n,seed,maxEvals,earlyStop:{patience}}, objective, splitDate, topK}'),
    shortlist_labels: z.string().optional().describe('JSON array of profile shortlist labels to include (default: all in profiles/pf3g-vp.json optimize.shortlist)'),
    meta_inputs: z.string().optional().describe('JSON array of metaInfo inputs [{id,name,type,options,min,max,step,defval}] used to resolve labels to ids and to seed ranges'),
    profile: z.string().optional().describe('Profile name (default pf3g-vp)'),
    settle_ms: z.coerce.number().optional().describe('Assumed settle time per run for the estimate (default 20000)'),
  }, async ({ space, shortlist_labels, meta_inputs, profile, settle_ms }) => {
    try {
      let raw = {};
      if (space) { try { raw = JSON.parse(space); } catch { return jsonResult({ success: false, error: 'space must be valid JSON' }, true); } }
      if (!raw.params || !raw.params.length) {
        if (!meta_inputs) return jsonResult({ success: false, error: 'provide space.params or meta_inputs (+ shortlist_labels) to resolve the profile shortlist' }, true);
        const meta = JSON.parse(meta_inputs);
        const p = loadProfile(profile);
        let list = (p.optimize && p.optimize.shortlist) || [];
        if (shortlist_labels) { const want = JSON.parse(shortlist_labels).map((l) => String(l).toLowerCase()); list = list.filter((x) => want.includes(x.label.toLowerCase())); }
        try { raw.params = resolveLabels(list, meta); raw.source = 'profile'; }
        catch (e) {
          // Not the profile's strategy (or its inputs were renamed): seed every input from metaInfo.
          raw.params = seedFromMeta(meta); raw.source = 'metaInfo';
          raw.note = 'profile shortlist does not fit this study (' + e.message + ') — seeded from the study inputs instead';
          if (!raw.params.length) return jsonResult({ success: false, error: raw.note + '; nothing seedable' }, true);
        }
        raw.seeded = seedFromMeta(meta).length;
      }
      // A seeded grid can dwarf the cap; the viewer's picker only needs the axes, so plan it as random.
      if (raw.source === 'metaInfo' && !(raw.sampler && raw.sampler.kind)) raw.sampler = { kind: 'random' };
      const sp = normalizeSpace(raw);
      const plan = planSpace(sp, { settleMs: settle_ms || 20000, paceMs: sp.pace_ms });
      const points = sp.sampler.kind === 'grid' ? expandGrid(sp) : sp.sampler.kind === 'random' ? sampleRandom(sp) : halvingPlan(sp).stage1;
      return jsonResult({ success: true, source: raw.source || 'user', ...(raw.note ? { note: raw.note } : {}), space: sp, plan, points, objectives: listObjectives() });
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
