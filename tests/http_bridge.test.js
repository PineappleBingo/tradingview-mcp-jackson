/**
 * HTTP bridge contract: /viewer is public static HTML, everything else stays token-gated.
 * Spawns scripts/http-bridge.js against tests/fixtures/stub-mcp-server.js (no TradingView).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
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

test('viewer file is small and fully self-contained', () => {
  // Ceiling tracks the phased viewer plan (tabs → reports → backtest → optimize).
  // It exists to catch an inlined library or a base64 asset, not to freeze the feature
  // set — the self-containment assertions below are the load-bearing ones. Raise it
  // deliberately per phase; do not bump it just to make a commit pass.
  assert.ok(statSync(VIEWER).size < 40 * 1024, 'viewer must stay under 40 KB');
  const html = readFileSync(VIEWER, 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheets');
  assert.ok(!/@import|https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no remote loads');
  assert.ok(html.includes('document.hidden'), 'pauses when hidden');
  assert.ok(html.includes('refresh'), 'supports ?refresh=');
});
