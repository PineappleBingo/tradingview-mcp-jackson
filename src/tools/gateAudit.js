import { z } from 'zod';
import { jsonResult } from './_format.js';
import { runGateAudit } from '../core/gateAudit.js';

export function registerGateAuditTools(server) {
  server.tool('strategy_gate_audit', 'Decode per-bar entry-gate verdicts for a strategy (default profile: PF 3G VP). For every bar returns side, pattern reason, fired/blocked/live, the failed gates, the primary blocker and its governing inputs, plus a summary with a blocker histogram. Prefer this over manually decoding "Audit Final Entry Pass Mask" bits. Works on TradingView Desktop (reads the chart model, not exportData).', {
    study_filter: z.string().optional().describe('Case-insensitive substring of the study title; overrides the profile default ("PF 3G")'),
    count: z.coerce.number().optional().describe('Bars from the end (default 200, max 500)'),
    profile: z.string().optional().describe('Profile name in profiles/ (default "pf3g-vp") or an absolute path to a .json profile'),
  }, async ({ study_filter, count, profile }) => {
    try { return jsonResult(await runGateAudit({ study_filter, count, profile })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
