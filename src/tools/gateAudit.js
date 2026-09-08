import { z } from 'zod';
import { jsonResult } from './_format.js';
import { runGateAudit } from '../core/gateAudit.js';
import { replay, METRIC_NAMES } from '../core/whatif.js';

export function registerGateAuditTools(server) {
  server.tool('strategy_gate_audit', 'Decode per-bar entry-gate verdicts for a strategy (default profile: PF 3G VP). For every bar returns side, pattern reason, fired/blocked/live, the failed gates, the primary blocker and its governing inputs, plus a summary with a blocker histogram. Prefer this over manually decoding "Audit Final Entry Pass Mask" bits. Works on TradingView Desktop (reads the chart model, not exportData).', {
    study_filter: z.string().optional().describe('Case-insensitive substring of the study title; overrides the profile default ("PF 3G")'),
    count: z.coerce.number().optional().describe('Bars from the end (default 200, max 500)'),
    profile: z.string().optional().describe('Profile name in profiles/ (default "pf3g-vp") or an absolute path to a .json profile'),
  }, async ({ study_filter, count, profile }) => {
    try { return jsonResult(await runGateAudit({ study_filter, count, profile })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_gate_whatif', `Counterfactual replay: test a proposed rule against the gate-audit history WITHOUT touching the chart, and get the bars it would have changed. Use this to verify a recommendation ("require ER >= 0.30", "the ATR path must still satisfy roomPct >= reqPct*0.7") before acting on it — especially for an indicator() script, which has no Strategy Tester and so cannot be backtested at all.

Two rule kinds:
  {"kind":"require","pred":{...}}   an EXTRA condition entries must meet  → FIRED becomes BLOCKED
  {"kind":"relax","gates":["RoomL"]} treat those gates as passing         → BLOCKED becomes FIRED (a bar unblocks only if EVERY gate that failed on it is listed)

pred := {"metric":M,"op":OP,"value":V} | {"all":[pred,...]} | {"any":[pred,...]} | {"not":pred}
  OP  : gt gte lt lte eq ne between
  V   : a number/boolean/string, [lo,hi] for between, or {"metric":M,"mul":0.7,"add":0} to compare two metrics
  M   : ${METRIC_NAMES.join(' ')}

CANNOT express (label these unverifiable rather than approximating them): anything with cross-bar state (streaks, cooldowns, "within N bars"), anything not plotted in the profile's audit columns (structure-level distances, intrabar path, a different ATR length), anything needing new Pine logic, and anything about the outcome (P&L, MAE/MFE).

Returns counts {fired.before, fired.after, flipped, unblocked, unknown}, the flipped bars with the metric values that decided them, the window replayed against, and a verdict of effective | no-effect | insufficient. "unknown" bars are ones where a metric the rule needs was na — they never count as a pass and never as a flip, and a rule unreadable on most bars comes back insufficient however the readable bars fell.`, {
    rule: z.string().describe('The rule as a JSON string, e.g. {"kind":"require","pred":{"metric":"roomPct","op":"gte","value":{"metric":"reqPct","mul":0.7}}}'),
    at_iso: z.string().optional().describe('The bar under review (full ISO or a prefix like "2026-09-08T16:30") — the result says whether that bar flipped'),
    study_filter: z.string().optional().describe('Case-insensitive substring of the study title; overrides the profile default ("PF 3G")'),
    count: z.coerce.number().optional().describe('Bars from the end (default 200, max 500)'),
    profile: z.string().optional().describe('Profile name in profiles/ (default "pf3g-vp") or an absolute path to a .json profile'),
  }, async ({ rule, at_iso, study_filter, count, profile }) => {
    let parsed;
    try { parsed = JSON.parse(rule); }
    catch (err) { return jsonResult({ success: false, error: `rule is not valid JSON: ${err.message}` }, true); }
    try {
      const audit = await runGateAudit({ study_filter, count, profile });
      const result = replay(audit.verdicts, parsed, { atIso: at_iso || null });
      if (!result.valid) return jsonResult({ success: false, error: result.reason, ...result }, true);
      return jsonResult({ success: true, study: audit.study, chart: audit.chart, rule: parsed, ...result });
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
