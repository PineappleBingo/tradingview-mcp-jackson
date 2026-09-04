/**
 * Sweep job — Phase 4. One chart-mutating job at a time, mirroring the /agent job.
 *
 * Runs strategy_run_backtest once per parameter point through the bridge's own in-process
 * callTool (never over HTTP, so the 30 s default ceiling is irrelevant), appends every run to
 * reports/sweeps/<id>.jsonl (quants-lab's persistent Optuna study with load_if_exists, minus
 * Optuna: a bridge restart loses only memory and POST /sweep/resume continues from the last
 * written index), restores the original inputs in `finally` and verifies the restore, then
 * selects a winner the honest way (src/core/sweep.js) and writes a type:'sweep' report.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeSpace, expandGrid, sampleRandom, halvingPlan, countEvals, pointKey } from '../src/core/paramspace.js';
import { summarizeRun, selectAndVerdict, matrixOf, decisionResolvedBy, realizedFor } from '../src/core/sweep.js';
import { list as listObjectives } from '../src/core/objectives.js';

const STUDY_RE = /PineForge|PF 3G/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\const STUDY_RE = /PineForge|PF 3G/i;');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v)) ? '–' : (Math.round(v * 10 ** d) / 10 ** d).toString();

export function createSweepRunner({ callTool, reportsDir, saveReport, newId, timeoutMs = 3_600_000, runTimeoutMs = 120_000, log = () => {} }) {
  let job = null;
  const journalDir = () => path.join(reportsDir, 'sweeps');
  const journalPath = (id) => path.join(journalDir(), id + '.jsonl');
  const journal = (id, rec) => { mkdirSync(journalDir(), { recursive: true }); appendFileSync(journalPath(id), JSON.stringify(rec) + '\n'); };
  const elapsedOf = (j) => (j.endedAt ?? Date.now()) - j.startedAt;

  const busy = () => !!(job && job.state === 'running');

  function publicStatus() {
    if (!job) return { busy: false, state: 'idle' };
    return {
      busy: job.state === 'running', id: job.id, state: job.state, title: job.title, startedAt: job.startedAt, elapsedMs: elapsedOf(job), expectedMs: job.expectedMs,
      total: job.total, done: job.done, current: job.current, objective: job.objective, splitDate: job.splitDate, sampler: job.space ? job.space.sampler.kind : null,
      baseline: job.baseline ? { objective: job.baseline.objective, netProfitPct: job.baseline.metrics.netProfitPct, profitFactor: job.baseline.metrics.profitFactor } : null,
      results: job.results.map((r) => ({ index: r.index, inputs: r.inputs, objective: r.objective, netProfitPct: r.metrics.netProfitPct, profitFactor: r.metrics.profitFactor, maxDrawdownPct: r.metrics.maxDrawdownPct, totalTrades: r.metrics.totalTrades, settled: r.settled })),
      restore: job.restore, reportId: job.reportId, error: job.error, reason: job.reason, resumable: (job.state === 'timeout' || job.state === 'error') && !!job.space,
    };
  }

  function planPoints(space, results) {
    const k = space.sampler.kind;
    if (k === 'grid') return expandGrid(space);
    if (k === 'random') return sampleRandom(space);
    const h = halvingPlan(space);
    const stage1 = h.stage1;
    if (results.length < stage1.length) return stage1;
    return stage1.concat(h.stage2(results.slice(0, stage1.length)));
  }

  // `study` is a name substring; without one: PF 3G, else the first strategy() script the
  // chart reports (chart_get_state flags them — an indicator has no Strategy Tester).
  async function resolveStudy(study) {
    const st = await callTool('chart_get_state', {}, 30_000);
    const list = (st && st.studies) || [];
    const flagged = list.some((s) => s.is_strategy);
    const found = study ? list.find((s) => new RegExp(escapeRe(study), 'i').test(s.name || ''))
      : flagged ? (list.find((s) => s.is_strategy && STUDY_RE.test(s.name || '')) || list.find((s) => s.is_strategy)) : list.find((s) => STUDY_RE.test(s.name || ''));
    if (!found) throw new Error((study || 'PF 3G VP') + ' strategy not found on the chart' + (list.some((s) => s.is_strategy) ? '' : ' — no strategy() script is loaded'));
    const study_ = found;
    return { entityId: study_.id || study_.entity_id, name: study_.name, symbol: st.symbol, timeframe: st.resolution };
  }

  async function readInputs(entityId, ids) {
    const ind = await callTool('data_get_indicator', { entity_id: entityId }, 30_000);
    const vals = {};
    for (const i of (ind && ind.inputs) || []) if (ids.includes(i.id)) vals[i.id] = i.value;
    return vals;
  }

  function renderSweepMd(j, selection, matrix) {
    const L = [`# Sweep · ${j.symbol || '?'} · ${j.timeframe || '?'} · ${j.objective}`, '',
      `${j.results.length} runs · sampler ${j.space.sampler.kind} · ${j.reason ? 'stopped: ' + j.reason + ' · ' : ''}restore ${j.restore.restored ? 'ok' : 'FAILED'}${j.restore.verified === false ? ' (verification failed)' : ''}`,
      '', `**Verdict: ${selection.verdict.toUpperCase()}** — ${selection.reasons.join('; ')}`];
    if (selection.selectedIndex != null) { const s = j.results[selection.selectedIndex]; L.push('', 'Selected: ' + Object.entries(s.inputs).map(([k, v]) => (j.labels[k] || k) + '=' + v).join(', ') + ` · objective ${fmt(s.objective, 4)} vs baseline ${fmt(j.baseline && j.baseline.objective, 4)}`); }
    L.push('', '| # | ' + j.space.params.map((p) => p.label || p.id).join(' | ') + ' | net % | PF | max DD % | trades | objective | OOS PF | settled |', '|' + '---|'.repeat(j.space.params.length + 8));
    for (const r of j.results) L.push(`| ${r.index} | ${j.space.params.map((p) => r.inputs[p.id]).join(' | ')} | ${fmt(r.metrics.netProfitPct)} | ${fmt(r.metrics.profitFactor, 3)} | ${fmt(r.metrics.maxDrawdownPct)} | ${r.metrics.totalTrades ?? '–'} | ${fmt(r.objective, 4)} | ${r.oos ? fmt(r.oos.profitFactor, 3) : '–'} | ${r.settled ? 'yes' : 'NO'} |`);
    if (j.baseline) L.push(`| base | ${j.space.params.map((p) => j.restore.original[p.id]).join(' | ')} | ${fmt(j.baseline.metrics.netProfitPct)} | ${fmt(j.baseline.metrics.profitFactor, 3)} | ${fmt(j.baseline.metrics.maxDrawdownPct)} | ${j.baseline.metrics.totalTrades ?? '–'} | ${fmt(j.baseline.objective, 4)} | ${j.baseline.oos ? fmt(j.baseline.oos.profitFactor, 3) : '–'} | ${j.baseline.settled ? 'yes' : 'NO'} |`);
    if (matrix) { L.push('', `Matrix (${matrix.rowParam} × ${matrix.colParam}, objective — smaller is better):`, '', '| | ' + matrix.cols.join(' | ') + ' |', '|' + '---|'.repeat(matrix.cols.length + 1)); matrix.rows.forEach((rv, ri) => L.push(`| ${rv} | ` + matrix.cells[ri].map((c) => c ? fmt(c.objective, 3) : '·').join(' | ') + ' |')); }
    L.push('', `${j.results.length} runs · one window · one symbol — a direction, not a result. Re-check on a held-out range before changing the live chart.`);
    return L.join('\n');
  }

  async function runLoop(j, { resumed = false } = {}) {
    const ids = j.space.params.map((p) => p.id);
    let killer = null;
    try {
      if (!resumed) {
        const study = await resolveStudy(j.study);
        Object.assign(j, { entityId: study.entityId, studyName: study.name, symbol: study.symbol, timeframe: study.timeframe });
        j.restore.original = await readInputs(j.entityId, ids);
        const missing = ids.filter((id) => !(id in j.restore.original));
        if (missing.length) throw new Error('inputs not found on the study: ' + missing.join(', '));
        journal(j.id, { type: 'header', id: j.id, title: j.title, study: j.study, space: j.space, objective: j.objective, splitDate: j.splitDate, costs: j.costs, labels: j.labels, original: j.restore.original, entityId: j.entityId, symbol: j.symbol, timeframe: j.timeframe, startedAt: j.startedAt });
        // baseline: the chart as it is
        j.current = { index: -1, inputs: j.restore.original };
        const base = await callTool('strategy_run_backtest', { config: JSON.stringify({ study: { entityId: j.entityId, name: j.studyName }, inputs: {}, splitDate: j.splitDate, costs: j.costs }) }, runTimeoutMs);
        if (!base || !base.success) throw new Error('baseline run failed: ' + (base && base.error));
        j.baseline = summarizeRun(base.card, { index: -1, inputs: j.restore.original, objective: j.objective, splitDate: j.splitDate, initialCapital: j.costs && j.costs.initialCapital });
        j.baseline.settleMs = base.card.settleMs; j.windowEnd = base.card.window && base.card.window.lastTradeTime;
        j.expectedMs = (j.total || countEvals(j.space)) * ((base.card.settleMs || 5000) + j.space.pace_ms + 500);
        journal(j.id, { type: 'baseline', baseline: j.baseline, windowEnd: j.windowEnd });
      } else if (j.entityId == null) { const study = await resolveStudy(j.study); j.entityId = study.entityId; j.studyName = study.name; }
      killer = setTimeout(() => { if (j.state === 'running') j.cancelFlag = 'timeout'; }, timeoutMs);
      if (killer.unref) killer.unref();

      let points = planPoints(j.space, j.results);
      j.total = Math.min(points.length, j.space.sampler.maxEvals);
      const doneKeys = new Set(j.results.map((r) => pointKey(r.inputs)));
      let bestSeen = Math.min(Infinity, ...j.results.map((r) => r.objective).filter((o) => o != null)), sinceBest = 0;
      for (let idx = j.results.length; idx < j.total; idx++) {
        if (j.cancelFlag) break;
        // halving: stage 2 is planned once stage 1 is complete
        if (j.space.sampler.kind === 'halving' && idx === halvingPlan(j.space).stage1.length) { points = planPoints(j.space, j.results); j.total = Math.min(points.length, j.space.sampler.maxEvals); if (idx >= j.total) break; }
        const inputs = points[idx];
        if (!inputs || doneKeys.has(pointKey(inputs))) continue;
        j.current = { index: idx, inputs };
        let r;
        try {
          const out = await callTool('strategy_run_backtest', { config: JSON.stringify({ study: { entityId: j.entityId, name: j.studyName }, inputs, labels: j.labels, restore: false, splitDate: j.splitDate, costs: j.costs }) }, runTimeoutMs);
          if (!out || !out.success) throw new Error((out && out.error) || 'run failed');
          r = summarizeRun(out.card, { index: idx, inputs, objective: j.objective, splitDate: j.splitDate, initialCapital: j.costs && j.costs.initialCapital });
        } catch (e) {
          r = { index: idx, inputs, configHash: null, metrics: {}, isMetrics: {}, oos: null, objective: null, settled: false, settleMs: null, warnings: ['run_failed'], pSharpe: null, verdict: null, error: e.message };
        }
        j.results.push(r); doneKeys.add(pointKey(inputs)); j.done = j.results.length;
        journal(j.id, { type: 'run', ...r });
        if (r.objective != null && r.objective < bestSeen) { bestSeen = r.objective; sinceBest = 0; } else sinceBest++;
        if (sinceBest >= j.space.sampler.earlyStop.patience && idx < j.total - 1) { j.reason = 'plateau'; break; }
        if (idx < j.total - 1 && j.space.pace_ms > 0) await wait(j.space.pace_ms);
      }
      if (j.cancelFlag) j.reason = j.cancelFlag;
    } catch (e) {
      j.error = e.message; j.reason = 'error';
    } finally {
      if (killer) clearTimeout(killer);
      j.current = null;
      // restore FIRST, whatever happened above — a CDP hiccup must never leave the chart silently mutated
      if (j.entityId && j.restore.original && Object.keys(j.restore.original).length) {
        try {
          await callTool('indicator_set_inputs', { entity_id: j.entityId, inputs: JSON.stringify(j.restore.original) }, 30_000);
          j.restore.restored = true;
          try { const now = await readInputs(j.entityId, ids); j.restore.verified = ids.every((id) => String(now[id]) === String(j.restore.original[id])); }
          catch { j.restore.verified = null; }
        } catch (e) { j.restore.restored = false; j.restore.error = e.message; }
      }
      j.endedAt = Date.now();
      if (j.error) j.state = 'error';
      else if (j.reason === 'cancelled') j.state = 'cancelled';
      else if (j.reason === 'timeout') j.state = 'timeout';
      else {
        try {
          const selection = selectAndVerdict(j.results, { space: j.space, baseline: j.baseline, topK: j.space.topK });
          const matrix = matrixOf(j.results, j.space);
          const rid = j.id;
          const body_md = renderSweepMd(j, selection, matrix);
          saveReport({ id: rid, createdAt: new Date(j.startedAt).toISOString(), type: 'sweep', title: j.title, summary: `${selection.verdict} · ${j.results.length} runs · ` + selection.reasons.slice(0, 2).join('; '), body_md, context: ['sweep'],
            elapsedMs: j.endedAt - j.startedAt,
            data: { study: j.study, space: j.space, objective: j.objective, splitDate: j.splitDate, costs: j.costs, labels: j.labels, symbol: j.symbol, timeframe: j.timeframe, entityName: j.studyName, windowEnd: j.windowEnd, baseline: j.baseline, results: j.results, selection, matrix, restore: j.restore, reason: j.reason || null } });
          j.reportId = rid; j.selection = selection; j.state = 'done';
        } catch (e) { j.error = 'report write failed: ' + e.message; j.state = 'error'; }
      }
      journal(j.id, { type: 'end', state: j.state, reason: j.reason || null, error: j.error || null, restore: j.restore, endedAt: j.endedAt });
      log(`[sweep] ${j.id} ${j.state}${j.reason ? ' (' + j.reason + ')' : ''} — ${j.results.length} runs, restore ${j.restore.restored ? 'ok' : 'FAILED'}`);
    }
  }

  function start({ space: rawSpace, objective, splitDate, title, costs, labels, study }) {
    if (busy()) throw Object.assign(new Error('a sweep is already running'), { code: 409, id: job.id });
    const space = normalizeSpace(rawSpace);
    const obj = objective || space.objective || 'multi_metric';
    if (!listObjectives().some((o) => o.name === obj)) throw Object.assign(new Error('unknown objective ' + obj), { code: 400 });
    const id = 'sw-' + newId();
    job = { id, state: 'running', startedAt: Date.now(), endedAt: null, expectedMs: countEvals(space) * 21_000, total: countEvals(space), done: 0, current: null,
      study: study ? String(study) : null, space, objective: obj, splitDate: splitDate || space.splitDate || null, costs: costs || null, labels: labels || Object.fromEntries(space.params.map((p) => [p.id, p.label || p.id])),
      title: title || ('sweep · ' + space.params.map((p) => p.label || p.id).join(' × ') + ' · ' + obj), baseline: null, results: [], restore: { original: {}, restored: false, verified: null, error: null }, reportId: null, error: null, reason: null, cancelFlag: null };
    runLoop(job).catch((e) => { job.error = e.message; job.state = 'error'; });
    return { id, total: job.total, expectedMs: job.expectedMs };
  }

  function cancel() {
    if (!busy()) throw Object.assign(new Error('no sweep in progress'), { code: 409, state: job ? job.state : 'idle' });
    job.cancelFlag = 'cancelled';
    return { ok: true, id: job.id };
  }

  function resume(id) {
    if (busy()) throw Object.assign(new Error('a sweep is already running'), { code: 409, id: job.id });
    const p = journalPath(id);
    if (!id || !/^[a-z0-9-]+$/.test(id) || !existsSync(p)) throw Object.assign(new Error('no journal for sweep ' + id), { code: 404 });
    const recs = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const header = recs.find((r) => r.type === 'header');
    if (!header) throw Object.assign(new Error('journal has no header'), { code: 400 });
    const baseline = recs.find((r) => r.type === 'baseline');
    const results = recs.filter((r) => r.type === 'run').map(({ type, ...r }) => r);
    const ended = recs.filter((r) => r.type === 'end').pop();
    if (ended && ended.state === 'done') throw Object.assign(new Error('sweep ' + id + ' already finished'), { code: 409 });
    job = { id, state: 'running', startedAt: header.startedAt || Date.now(), endedAt: null, expectedMs: countEvals(header.space) * 21_000, total: countEvals(header.space), done: results.length, current: null,
      study: header.study || null, space: header.space, objective: header.objective, splitDate: header.splitDate, costs: header.costs, labels: header.labels || {}, title: header.title, entityId: header.entityId, studyName: null, symbol: header.symbol, timeframe: header.timeframe,
      baseline: baseline ? baseline.baseline : null, windowEnd: baseline ? baseline.windowEnd : null, results, restore: { original: header.original, restored: false, verified: null, error: null }, reportId: null, error: null, reason: null, cancelFlag: null, resumedFrom: id };
    journal(id, { type: 'resume', at: Date.now(), from: results.length });
    runLoop(job, { resumed: true }).catch((e) => { job.error = e.message; job.state = 'error'; });
    return { id, resumedFrom: id, from: results.length, total: job.total };
  }

  async function apply(id, index, { readReport }) {
    if (busy()) throw Object.assign(new Error('a sweep is running — apply after it finishes'), { code: 409 });
    const rep = readReport(id);
    if (!rep || rep.type !== 'sweep') throw Object.assign(new Error('no sweep report ' + id), { code: 404 });
    const r = (rep.data.results || []).find((x) => x.index === Number(index));
    if (!r) throw Object.assign(new Error('no run with index ' + index), { code: 404 });
    const study = await resolveStudy(rep.data.study);
    await callTool('indicator_set_inputs', { entity_id: study.entityId, inputs: JSON.stringify(r.inputs) }, 30_000);
    const did = 'dc-' + newId();
    const sel = rep.data.selection || {};
    // Cut at the applied run's own last trade; windowEnd (the baseline's) is the pre-fix fallback.
    const cut = (r.window && r.window.lastTradeTime) || rep.data.windowEnd || null;
    const body_md = `# Decision · applied sweep ${id} run ${r.index}\n\n` + Object.entries(r.inputs).map(([k, v]) => '- ' + ((rep.data.labels || {})[k] || k) + ' = ' + v).join('\n') + `\n\nSweep verdict: **${sel.verdict || 'n/a'}** — ${(sel.reasons || []).join('; ')}\n\nStatus: pending — a later backtest of the same config whose window extends past ${cut || '?'} resolves this decision with realised figures.`;
    saveReport({ id: did, createdAt: new Date().toISOString(), type: 'decision', title: 'decision · ' + Object.entries(r.inputs).map(([k, v]) => ((rep.data.labels || {})[k] || k) + '=' + v).join(', '), summary: 'pending · sweep verdict ' + (sel.verdict || 'n/a'), body_md, context: ['sweep', id],
      data: { status: 'pending', configHash: r.configHash, inputs: r.inputs, labels: rep.data.labels || {}, verdict: sel.verdict || null, sweepReportId: id, runIndex: r.index, lastTradeTime: cut, objective: r.objective, baselineObjective: rep.data.baseline ? rep.data.baseline.objective : null, symbol: rep.data.symbol, timeframe: rep.data.timeframe } });
    return { id: did, applied: r.inputs };
  }

  /**
   * TradingAgents' pending → resolved back-fill: after any successful backtest, every pending
   * decision with the same configHash whose window the new run extends past gets its realised
   * out-of-sample figures written in. Returns the ids it resolved.
   */
  function resolvePending(card) {
    const out = [];
    let files = [];
    try { files = readdirSync(reportsDir).filter((f) => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
      let rep; try { rep = JSON.parse(readFileSync(path.join(reportsDir, f), 'utf8')); } catch { continue; }
      if (!rep || rep.type !== 'decision' || !rep.data || rep.data.status !== 'pending') continue;
      if (!decisionResolvedBy(rep.data, card)) continue;
      const realized = realizedFor(rep.data, card, { initialCapital: card.config && card.config.costs && card.config.costs.initialCapital });
      const held = realized.n > 0 ? (realized.netProfit > 0 && (realized.profitFactor == null || realized.profitFactor > 1)) : null;
      rep.data = { ...rep.data, status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: card.id || null, realized, held };
      rep.summary = 'resolved · ' + (held == null ? 'no new trades yet' : held ? 'held out-of-sample' : 'did NOT hold out-of-sample') + ' · sweep verdict ' + (rep.data.verdict || 'n/a');
      rep.body_md = (rep.body_md || '').replace(/Status: pending[^\n]*/, `Status: resolved ${rep.data.resolvedAt.slice(0, 16)}Z — ${realized.n} new trades since ${realized.from || '?'}: net ${fmt(realized.netProfit)} · PF ${fmt(realized.profitFactor, 3)} · win rate ${fmt(realized.winRate)} % → ${held == null ? 'inconclusive' : held ? 'the decision HELD' : 'the decision did NOT hold'}`)
        + `\n\nLesson: _write 2–4 sentences on what held, what failed and one actionable change (or run the "resolve decision" preset)._`;
      saveReport(rep); out.push(rep.id);
    }
    return out;
  }

  return { start, cancel, resume, apply, resolvePending, status: publicStatus, busy, current: () => job, objectives: listObjectives };
}
