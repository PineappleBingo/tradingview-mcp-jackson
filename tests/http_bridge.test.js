/**
 * HTTP bridge contract: /viewer is public static HTML, everything else stays token-gated.
 * Spawns scripts/http-bridge.js against tests/fixtures/stub-mcp-server.js (no TradingView).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'scripts', 'http-bridge.js');
const STUB = path.join(__dirname, 'fixtures', 'stub-mcp-server.js');
const VIEWER = path.join(ROOT, 'scripts', 'viewer', 'gate-audit.html');
const TOKEN = 't0k';

let proc, base;

const MAIN_REPORTS = path.join(tmpdir(), 'tv-bridge-main-reports-' + Date.now() + '-' + Math.random().toString(36).slice(2));

before(async () => {
  proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, MCP_BRIDGE_PORT: '0', MCP_BRIDGE_TOKEN: TOKEN, MCP_SERVER_PATH: STUB, MCP_BRIDGE_REPORTS_DIR: MAIN_REPORTS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('bridge did not report a bound port:\n' + out)), 8000);
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:(\d+))/);
      if (m && m[2] !== '0') { clearTimeout(timer); resolve(m[1]); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error('bridge exited ' + c + ':\n' + out)); });
  });
});

after(() => new Promise((resolve) => {
  if (!proc || proc.exitCode !== null) return resolve();
  proc.on('exit', resolve);
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000).unref();
}));

const call = (tool, params, token = TOKEN) => fetch(base + '/call', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ tool, params }),
});

test('GET /viewer serves the dashboard without a token', async () => {
  const res = await fetch(base + '/viewer');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.ok(body.includes('strategy_gate_audit'));
  assert.ok(body.includes('localStorage'));
});

test('GET /favicon.ico is a public 204 so the viewer logs no 401 noise', async () => {
  const res = await fetch(base + '/favicon.ico');
  assert.equal(res.status, 204);
});

test('GET /viewer?refresh=5 still routes (pathname-based routing)', async () => {
  const res = await fetch(base + '/viewer?refresh=5');
  assert.equal(res.status, 200);
});

test('POST /call and GET /health are 401 without or with a wrong token', async () => {
  assert.equal((await call('ping', {}, null)).status, 401);
  assert.equal((await call('ping', {}, 'wrong')).status, 401);
  assert.equal((await fetch(base + '/health')).status, 401);
});

test('POST /call proxies to the MCP server with a valid token', async () => {
  const res = await call('ping', { a: 1 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.echo.tool, 'ping');
  assert.equal(body.echo.params.a, 1);
});

test('tool failure → 500, CDP-down failure → 503', async () => {
  const fail = await call('fail_tool', {});
  assert.equal(fail.status, 500);
  assert.equal((await fail.json()).error, 'boom');
  const down = await call('cdp_down', {});
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /CDP/);
});

test('invalid JSON body → 400; unknown route → 404 listing /viewer', async () => {
  const bad = await fetch(base + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: '{nope' });
  assert.equal(bad.status, 400);
  const nf = await fetch(base + '/nope', { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(nf.status, 404);
  assert.match((await nf.json()).error, /\/viewer/);
});

test('agent cancel: POST /agent/cancel → state cancelled, not a bogus error', async (t) => {
  // 30s shim so the run is reliably still in flight when we cancel it.
  const base2 = await startAgentBridge(t, { FAKE_CLAUDE_SLEEP: '30' });

  assert.equal((await fetch(base2 + '/agent/cancel', { method: 'POST', headers: AH })).status, 409,
    'cancel with nothing running → 409');

  const { id } = await (await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'long run' }) })).json();
  assert.ok(id);
  let st = await (await fetch(base2 + '/agent/status', { headers: AH })).json();
  assert.equal(st.state, 'running');

  assert.equal((await fetch(base2 + '/agent/cancel', { method: 'POST', headers: AH })).status, 200);

  for (let i = 0; i < 60; i++) {
    st = await (await fetch(base2 + '/agent/status', { headers: AH })).json();
    if (st.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // The killed child exits non-zero; without the halt flag this would surface as
  // a confusing 'failed: <stderr>' instead of a clean cancellation.
  assert.equal(st.state, 'cancelled', 'cancelled run reports cancelled: ' + JSON.stringify(st));
  assert.ok(!st.error, 'cancellation is not an error');
  assert.equal(st.busy, false);

  // A cancel must free the slot so ↻ retry can start a new run immediately.
  assert.equal((await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'retry' }) })).status, 200,
    'slot is free after cancel');
});

test('agent progress: stream-json yields session id, step label and a frozen elapsed', async (t) => {
  const base2 = await startAgentBridge(t, { FAKE_CLAUDE_SLEEP: '2' });
  await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'p' }) });

  let seenStep = null;
  for (let i = 0; i < 40; i++) {
    const st = await (await fetch(base2 + '/agent/status', { headers: AH })).json();
    if (st.stepLabel) seenStep = st;
    if (st.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(seenStep, 'a tool_use event surfaced a step label while running');
  assert.match(seenStep.stepLabel, /strategy gate audit/, 'label is humanised: ' + seenStep.stepLabel);
  assert.ok(seenStep.expectedMs > 0, 'a baseline is published for the progress bar');

  let done;
  for (let i = 0; i < 40; i++) {
    done = await (await fetch(base2 + '/agent/status', { headers: AH })).json();
    if (done.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(done.state, 'done', JSON.stringify(done));

  // elapsedMs must freeze at exit. It used to be Date.now()-startedAt, so a finished run's
  // elapsed climbed forever and a killed run looked like it was still alive.
  const first = (await (await fetch(base2 + '/agent/status', { headers: AH })).json()).elapsedMs;
  await new Promise((r) => setTimeout(r, 600));
  const second = (await (await fetch(base2 + '/agent/status', { headers: AH })).json()).elapsedMs;
  assert.equal(first, second, 'elapsedMs is frozen once the run ends');

  // The report body now comes from the result event, not raw stdout.
  const rep = await (await fetch(base2 + '/reports/' + done.reportId, { headers: AH })).json();
  assert.match(rep.body_md, /summary paragraph/, 'report survives the stream-json switch');
  assert.equal(rep.title, 'Fake Analysis');
});

test('agent timeout is resumable: state timeout → POST /agent/resume continues the session', async (t) => {
  // Child stalls 30s against a 1.5s ceiling, so the timeout fires mid-run.
  const base2 = await startAgentBridge(t, { FAKE_CLAUDE_SLEEP: '30', MCP_BRIDGE_AGENT_TIMEOUT_MS: '1500' });

  assert.equal((await fetch(base2 + '/agent/resume', { method: 'POST', headers: AH })).status, 409,
    'nothing to continue → 409');

  await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'slow one' }) });
  let st;
  for (let i = 0; i < 60; i++) {
    st = await (await fetch(base2 + '/agent/status', { headers: AH })).json();
    if (st.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Not 'error': the session survives on disk, so the work is continuable.
  assert.equal(st.state, 'timeout', 'timeout is its own state: ' + JSON.stringify(st));
  assert.equal(st.resumable, true, 'a captured session id makes it resumable');
  assert.match(st.error, /timed out after \d+s/);

  // Resume must run long enough to finish: give the shim a short sleep this time.
  process.env.FAKE_CLAUDE_SLEEP = '0';
  const r = await fetch(base2 + '/agent/resume', { method: 'POST', headers: AH });
  assert.equal(r.status, 200);
  const { resumedFrom } = await r.json();
  assert.ok(resumedFrom, 'resume reports which run it continued');
});

test('viewer file is small and fully self-contained', () => {
  // Ceiling tracks the phased viewer plan (tabs → reports → backtest → optimize).
  // It exists to catch an inlined library or a base64 asset, not to freeze the feature
  // set — the self-containment assertions below are the load-bearing ones. Raise it
  // deliberately per phase; do not bump it just to make a commit pass.
  // 70 KB covered Phase 2.1 (Alerts tab). 84 KB covered Phase 3 (Backtest tab). 100 KB covers
  // Phase 4 (Optimize tab: space composer, sweep progress, overlay, matrix, apply).
  assert.ok(statSync(VIEWER).size < 100 * 1024, 'viewer must stay under 100 KB');
  const html = readFileSync(VIEWER, 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheets');
  assert.ok(!/@import|https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no remote loads');
  assert.ok(html.includes('document.hidden'), 'pauses when hidden');
  assert.ok(html.includes('refresh'), 'supports ?refresh=');
  assert.ok(html.includes('strategy_run_backtest') && html.includes("type: 'backtest'"), 'Backtest tab runs the tool and saves a backtest report');
  assert.ok(html.includes("'/sweep/status'") && html.includes("'/sweep/apply'"), 'Optimize tab drives the sweep job');
});

// ── agent + reports (Phase 2) ────────────────────────────────────────────────

test('agent endpoints are 404 while MCP_BRIDGE_ALLOW_AGENT is unset', async () => {
  const h = { Authorization: 'Bearer ' + TOKEN };
  assert.equal((await fetch(base + '/agent', { method: 'POST', headers: h, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/agent/status', { headers: h })).status, 404);
});

// Boots a bridge with the agent enabled and `claude` shimmed to the fake in
// fixtures/fakebin. Returns its base URL; the process is killed when the test ends.
async function startAgentBridge(t, extraEnv = {}) {
  const fakebin = path.join(__dirname, 'fixtures', 'fakebin');
  const repDir = path.join(tmpdir(), 'tv-bridge-reports-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const p2 = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env, MCP_BRIDGE_PORT: '0', MCP_BRIDGE_TOKEN: TOKEN, MCP_SERVER_PATH: STUB,
      MCP_BRIDGE_ALLOW_AGENT: '1', MCP_BRIDGE_REPORTS_DIR: repDir,
      PATH: fakebin + path.delimiter + process.env.PATH, ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { p2.kill('SIGTERM'); } catch {} });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('agent bridge did not bind:\n' + out)), 8000);
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:(\d+))/);
      if (m && m[2] !== '0') { clearTimeout(timer); resolve(m[1]); }
    };
    p2.stdout.on('data', onData); p2.stderr.on('data', onData);
    p2.on('exit', (c) => { clearTimeout(timer); reject(new Error('agent bridge exited ' + c + ':\n' + out)); });
  });
}
const AH = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

test('agent job: run → 409 while busy → report saved, listed, fetched, deleted', async (t) => {
  const base2 = await startAgentBridge(t);
  const H = AH;

  assert.equal((await fetch(base2 + '/agent/status')).status, 401, 'agent endpoints stay token-gated');
  const health = await (await fetch(base2 + '/health', { headers: H })).json();
  assert.equal(health.agent, true, '/health advertises the agent');

  const start = await fetch(base2 + '/agent', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'test run', context: ['x'] }) });
  assert.equal(start.status, 200);
  const { id } = await start.json();
  assert.ok(id);
  assert.equal((await fetch(base2 + '/agent', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'again' }) })).status, 409, 'second run while busy → 409');

  let st;
  for (let i = 0; i < 60; i++) {
    st = await (await fetch(base2 + '/agent/status', { headers: H })).json();
    if (st.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(st.state, 'done', 'run finished: ' + JSON.stringify(st));
  assert.equal(st.reportId, id);

  const list = await (await fetch(base2 + '/reports', { headers: H })).json();
  assert.equal(list.count, 1);
  assert.equal(list.reports[0].title, 'Fake Analysis');
  const rep = await (await fetch(base2 + '/reports/' + id, { headers: H })).json();
  assert.match(rep.body_md, /summary paragraph/);
  assert.match(rep.summary, /summary paragraph/);
  assert.deepEqual(rep.context, ['x']);

  assert.equal((await fetch(base2 + '/reports/NOPE!', { headers: H })).status, 400, 'unsafe report id rejected');
  assert.equal((await fetch(base2 + '/reports/' + id, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(base2 + '/reports/' + id, { headers: H })).status, 404);
});

// ── Phase 3: POST /reports and per-call timeouts ────────────────────────────

test('POST /reports saves a backtest report the list and detail routes serve; bad input is rejected', async () => {
  const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const health = await (await fetch(base + '/health', { headers: H })).json();
  assert.equal(health.postReports, true, '/health advertises POST /reports for viewer feature-detection');

  const card = { id: 'bt-x', metrics: { netProfit: 12.5 }, trades: [{ n: 1, pnl: 12.5 }] };
  const res = await fetch(base + '/reports', { method: 'POST', headers: H, body: JSON.stringify({ type: 'backtest', title: 'SOLUSD 5 · Hard Filter', body_md: '# Backtest\n\nnet +12.5', data: card, context: ['backtest'] }) });
  assert.equal(res.status, 200);
  const { id, type } = await res.json();
  assert.match(id, /^[a-z0-9-]+$/); assert.equal(type, 'backtest');

  const list = await (await fetch(base + '/reports', { headers: H })).json();
  const row = list.reports.find((r) => r.id === id);
  assert.ok(row, 'listed'); assert.equal(row.type, 'backtest'); assert.equal(row.summary, 'net +12.5');
  assert.equal(row.data, undefined, 'the list projection never carries the payload');
  const rep = await (await fetch(base + '/reports/' + id, { headers: H })).json();
  assert.deepEqual(rep.data, card); assert.deepEqual(rep.context, ['backtest']);
  assert.equal((await fetch(base + '/reports/' + id, { method: 'DELETE', headers: H })).status, 200);

  assert.equal((await fetch(base + '/reports', { method: 'POST', headers: H, body: JSON.stringify({ type: 'analysis', title: 't', body_md: '' }) })).status, 400, 'agent-only type rejected');
  assert.equal((await fetch(base + '/reports', { method: 'POST', headers: H, body: JSON.stringify({ type: 'backtest', body_md: '' }) })).status, 400, 'title required');
  assert.equal((await fetch(base + '/reports', { method: 'POST', headers: H, body: JSON.stringify({ type: 'backtest', title: 't' }) })).status, 400, 'body_md required');
  assert.equal((await fetch(base + '/reports', { method: 'POST', headers: H, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/reports', { method: 'POST', body: '{}' })).status, 401, 'token-gated');
});

test('POST /reports rejects a body over 5 MB with 413', async () => {
  const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const big = JSON.stringify({ type: 'backtest', title: 'big', body_md: 'x'.repeat(5 * 1024 * 1024 + 10) });
  let status;
  try { status = (await fetch(base + '/reports', { method: 'POST', headers: H, body: big })).status; }
  catch (e) { status = 413; } // the bridge destroys the socket after answering; node may surface that as a fetch error
  assert.equal(status, 413);
});

test('POST /call honours timeoutMs (clamped): a slow tool times out at 1 s but completes at the default', async () => {
  const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const fast = await fetch(base + '/call', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'slow_tool', params: { delay_ms: 1500 }, timeoutMs: 1000 }) });
  assert.equal(fast.status, 500);
  assert.match((await fast.json()).error, /timed out/);
  const ok = await fetch(base + '/call', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'slow_tool', params: { delay_ms: 300 }, timeoutMs: 999999 }) });
  assert.equal(ok.status, 200, 'an oversized timeoutMs is clamped, not rejected');
  assert.equal((await ok.json()).slow, true);
  const bt = await (await fetch(base + '/call', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'strategy_run_backtest', params: { inputs: '{"in_3":"Hard Filter"}' }, timeoutMs: 60000 }) })).json();
  assert.equal(bt.success, true); assert.equal(bt.card.kind, 'backtest'); assert.deepEqual(bt.card.config.inputs, { in_3: 'Hard Filter' });
});

// ── Phase 4: sweep job ───────────────────────────────────────────────────────

const SPACE = { params: [{ id: 'in_3', label: 'Trend Gate Mode', values: ['Soft Filter', 'Hard Filter'] }, { id: 'in_7', label: 'ER Range Threshold', type: 'decimal', min: 0.2, max: 0.25, step: 0.05 }], sampler: { kind: 'grid' }, pace_ms: 0 };
const H2 = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const untilSweep = async (b, pred, tries = 80) => { let st; for (let i = 0; i < tries; i++) { st = await (await fetch(b + '/sweep/status', { headers: H2 })).json(); if (pred(st)) return st; await new Promise((r) => setTimeout(r, 100)); } return st; };

test('sweep job: start → 409 while busy → journal + sweep report with selection, inputs restored and verified', async () => {
  const health = await (await fetch(base + '/health', { headers: H2 })).json();
  assert.equal(health.sweep, true);
  const objs = await (await fetch(base + '/sweep/objectives', { headers: H2 })).json();
  assert.ok(objs.objectives.some((o) => o.name === 'multi_metric' && o.default));

  const start = await fetch(base + '/sweep', { method: 'POST', headers: H2, body: JSON.stringify({ space: SPACE, objective: 'only_profit', title: 'grid 2×2' }) });
  const startTxt = await start.text();
  assert.equal(start.status, 200, startTxt);
  const { id, total } = JSON.parse(startTxt);
  assert.match(id, /^sw-[a-z0-9-]+$/); assert.equal(total, 4);
  const again = await fetch(base + '/sweep', { method: 'POST', headers: H2, body: JSON.stringify({ space: SPACE }) });
  assert.equal(again.status, 409);

  const st = await untilSweep(base, (s) => s.state !== 'running');
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.equal(st.done, 4); assert.equal(st.results.length, 4); assert.equal(st.reportId, id);
  assert.equal(st.restore.restored, true); assert.equal(st.restore.verified, true, 'inputs read back equal the originals');
  assert.deepEqual(st.restore.original, { in_3: 'Soft Filter', in_7: 0.25 });

  const rep = await (await fetch(base + '/reports/' + id, { headers: H2 })).json();
  assert.equal(rep.type, 'sweep'); assert.equal(rep.data.results.length, 4); assert.ok(rep.data.baseline);
  assert.ok(rep.data.selection && rep.data.selection.ranked.length === 4);
  assert.ok(['edge', 'noise', 'insufficient'].includes(rep.data.selection.verdict));
  assert.equal(rep.data.selection.verdict, 'insufficient', '4 runs < 8 settled runs → insufficient');
  assert.ok(rep.data.matrix && rep.data.matrix.rows.length === 2 && rep.data.matrix.cols.length === 2);
  assert.match(rep.body_md, /a direction, not a result/);
  const ranked = rep.data.selection.ranked.map((i) => rep.data.results[i].objective);
  assert.deepEqual(ranked, ranked.slice().sort((a, b) => a - b), 'ranked ascending (smaller objective is better)');

  const jl = readFileSync(path.join(MAIN_REPORTS, 'sweeps', id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(jl.map((r) => r.type), ['header', 'baseline', 'run', 'run', 'run', 'run', 'end']);
  assert.equal(jl[jl.length - 1].state, 'done');
});

test('sweep cancel restores the original inputs and reports cancelled; apply writes a pending decision', async () => {
  const slow = { ...SPACE, pace_ms: 400 };
  const { id } = await (await fetch(base + '/sweep', { method: 'POST', headers: H2, body: JSON.stringify({ space: slow }) })).json();
  await untilSweep(base, (s) => s.done >= 1);
  assert.equal((await fetch(base + '/sweep/cancel', { method: 'POST', headers: H2 })).status, 200);
  const st = await untilSweep(base, (s) => s.state !== 'running');
  assert.equal(st.state, 'cancelled', JSON.stringify(st)); assert.equal(st.reason, 'cancelled');
  assert.ok(st.done < 4); assert.equal(st.restore.restored, true); assert.equal(st.restore.verified, true);
  assert.equal((await fetch(base + '/sweep/cancel', { method: 'POST', headers: H2 })).status, 409, 'nothing to cancel → 409');
  assert.equal((await fetch(base + '/reports/' + id, { headers: H2 })).status, 404, 'a cancelled sweep writes no report');

  // apply a run from the finished sweep of the previous test
  const list = await (await fetch(base + '/reports', { headers: H2 })).json();
  const sw = list.reports.find((r) => r.type === 'sweep');
  assert.ok(sw, 'sweep report listed');
  const ap = await fetch(base + '/sweep/apply', { method: 'POST', headers: H2, body: JSON.stringify({ id: sw.id, index: 1 }) });
  const apTxt = await ap.text();
  assert.equal(ap.status, 200, apTxt);
  const { id: did, applied } = JSON.parse(apTxt);
  assert.match(did, /^dc-/); assert.equal(applied.in_3, 'Soft Filter'); assert.equal(applied.in_7, 0.25);
  const dec = await (await fetch(base + '/reports/' + did, { headers: H2 })).json();
  assert.equal(dec.type, 'decision'); assert.equal(dec.data.status, 'pending'); assert.equal(dec.data.sweepReportId, sw.id);
  const swRep = await (await fetch(base + '/reports/' + sw.id, { headers: H2 })).json();
  const applied1 = swRep.data.results.find((r) => r.index === 1);
  assert.ok(applied1.window && applied1.window.lastTradeTime, 'each journal result carries its own window');
  assert.equal(dec.data.lastTradeTime, applied1.window.lastTradeTime, 'the decision is cut at the APPLIED run\'s last trade');
  assert.notEqual(dec.data.lastTradeTime, swRep.data.windowEnd, 'not at the baseline\'s');
  const ind = await (await call('data_get_indicator', { entity_id: 'pf1' })).json();
  assert.equal(ind.inputs.find((i) => i.id === 'in_7').value, 0.25, 'apply set the chart inputs');
  assert.equal((await fetch(base + '/sweep/apply', { method: 'POST', headers: H2, body: JSON.stringify({ id: sw.id, index: 99 }) })).status, 404);

  // a later backtest of the SAME settings over a window that extends past the sweep's resolves the decision
  await new Promise((r) => setTimeout(r, 20));
  const later = await (await fetch(base + '/call', { method: 'POST', headers: H2, body: JSON.stringify({ tool: 'strategy_run_backtest', params: { inputs: JSON.stringify(applied) } }) })).json();
  assert.equal(later.success, true);
  assert.deepEqual(later.resolvedDecisions, [did], 'the run reports which decision it resolved');
  const dec2 = await (await fetch(base + '/reports/' + did, { headers: H2 })).json();
  assert.equal(dec2.data.status, 'resolved'); assert.ok(dec2.data.realized && typeof dec2.data.realized.n === 'number');
  assert.match(dec2.body_md, /Status: resolved/);
  const other = await (await fetch(base + '/call', { method: 'POST', headers: H2, body: JSON.stringify({ tool: 'strategy_run_backtest', params: { inputs: JSON.stringify({ in_3: 'Hard Filter', in_7: 0.2 }) } }) })).json();
  assert.equal(other.resolvedDecisions, undefined, 'a different config resolves nothing');
});

test('sweep resume continues a journal from its last written run', async () => {
  const id = 'sw-resume-test';
  const dir = path.join(MAIN_REPORTS, 'sweeps');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const space = { params: [{ id: 'in_3', label: 'Trend Gate Mode', type: 'categorical', values: ['Soft Filter', 'Hard Filter'], source: 'user' }, { id: 'in_7', label: 'ER', type: 'decimal', values: [0.2, 0.25], min: 0.2, max: 0.25, step: 0.05, source: 'user' }], sampler: { kind: 'grid', seed: 42, maxEvals: 64, n: 16, earlyStop: { patience: 10 } }, objective: 'only_profit', splitDate: null, topK: 3, pace_ms: 0 };
  const header = { type: 'header', id, title: 'resumed', space, objective: 'only_profit', splitDate: null, costs: null, labels: {}, original: { in_3: 'Soft Filter', in_7: 0.25 }, entityId: 'pf1', symbol: 'STUB:SOLUSD', timeframe: '5', startedAt: Date.now() - 1000 };
  const run = (index, inputs) => ({ type: 'run', index, inputs, configHash: 'x', metrics: { netProfit: 1, netProfitPct: 0.01, totalTrades: 35 }, isMetrics: { netProfit: 1, totalTrades: 35 }, oos: null, objective: -1, settled: true, warnings: [], pSharpe: 0.5, verdict: 'noise' });
  writeFileSync(path.join(dir, id + '.jsonl'), [header, { type: 'baseline', baseline: { index: -1, inputs: header.original, metrics: { netProfit: 0 }, objective: 0, settled: true }, windowEnd: null }, run(0, { in_3: 'Soft Filter', in_7: 0.2 }), run(1, { in_3: 'Soft Filter', in_7: 0.25 }), { type: 'end', state: 'timeout', reason: 'timeout' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = await fetch(base + '/sweep/resume', { method: 'POST', headers: H2, body: JSON.stringify({ id }) });
  const rTxt = await r.text();
  assert.equal(r.status, 200, rTxt);
  assert.equal(JSON.parse(rTxt).from, 2);
  const st = await untilSweep(base, (s) => s.state !== 'running');
  assert.equal(st.state, 'done', JSON.stringify(st)); assert.equal(st.done, 4);
  const rep = await (await fetch(base + '/reports/' + id, { headers: H2 })).json();
  assert.equal(rep.data.results.length, 4);
  assert.deepEqual(rep.data.results.slice(2).map((x) => x.inputs.in_3), ['Hard Filter', 'Hard Filter']);
  assert.equal((await fetch(base + '/sweep/resume', { method: 'POST', headers: H2, body: JSON.stringify({ id }) })).status, 409, 'finished sweeps do not resume');
  assert.equal((await fetch(base + '/sweep/resume', { method: 'POST', headers: H2, body: JSON.stringify({ id: 'sw-nope' }) })).status, 404);
});

test('chart lock: a sweep cannot start while an agent run is active, and vice-versa', async (t) => {
  const base2 = await startAgentBridge(t, { FAKE_CLAUDE_SLEEP: '30' });
  await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'hold the chart' }) });
  const sw = await fetch(base2 + '/sweep', { method: 'POST', headers: AH, body: JSON.stringify({ space: SPACE }) });
  assert.equal(sw.status, 409); assert.match((await sw.json()).error, /agent run/);
  await fetch(base2 + '/agent/cancel', { method: 'POST', headers: AH });
  for (let i = 0; i < 60; i++) { const st = await (await fetch(base2 + '/agent/status', { headers: AH })).json(); if (st.state !== 'running') break; await new Promise((r) => setTimeout(r, 200)); }
  const slow = { ...SPACE, pace_ms: 600 };
  assert.equal((await fetch(base2 + '/sweep', { method: 'POST', headers: AH, body: JSON.stringify({ space: slow }) })).status, 200);
  const ag = await fetch(base2 + '/agent', { method: 'POST', headers: AH, body: JSON.stringify({ prompt: 'x' }) });
  assert.equal(ag.status, 409); assert.match((await ag.json()).error, /sweep/);
  await fetch(base2 + '/sweep/cancel', { method: 'POST', headers: AH });
});
