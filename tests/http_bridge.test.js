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

before(async () => {
  proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, MCP_BRIDGE_PORT: '0', MCP_BRIDGE_TOKEN: TOKEN, MCP_SERVER_PATH: STUB },
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

test('viewer file is small and fully self-contained', () => {
  // Ceiling tracks the phased viewer plan (tabs → reports → backtest → optimize).
  // It exists to catch an inlined library or a base64 asset, not to freeze the feature
  // set — the self-containment assertions below are the load-bearing ones. Raise it
  // deliberately per phase; do not bump it just to make a commit pass.
  // 60 KB covers Phase 1.7 (stop/retry controls on a run). Next bump belongs to Phase 3.
  assert.ok(statSync(VIEWER).size < 60 * 1024, 'viewer must stay under 60 KB');
  const html = readFileSync(VIEWER, 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheets');
  assert.ok(!/@import|https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no remote loads');
  assert.ok(html.includes('document.hidden'), 'pauses when hidden');
  assert.ok(html.includes('refresh'), 'supports ?refresh=');
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
