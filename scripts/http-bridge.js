#!/usr/bin/env node
/**
 * TradingView MCP HTTP Bridge — expose the stdio MCP server over HTTP.
 *
 * HTTP client (web app, curl, a remote Claude Code session via tunnel)
 *   → HTTP :3001 (this bridge)
 *   → stdio JSON-RPC → tradingview-mcp server (src/server.js)
 *   → CDP :9222 → TradingView Desktop
 *
 * Endpoints:
 *   GET  /viewer  → live Gate Audit dashboard (static HTML, no token needed — it
 *                   asks for the token itself and calls POST /call)
 *   GET  /health  → { ok, connected, server }        (503 when TV/CDP is down)
 *   GET  /tools   → { tools: [{ name, description }] }
 *   POST /call    → body { tool, params } → MCP tool result (JSON; 503 when the
 *                   tool failed because TradingView/CDP is unreachable)
 *   POST /agent   → { prompt } → { id }; runs `claude -p` on this host (opt-in via
 *                   MCP_BRIDGE_ALLOW_AGENT=1 — NEVER behind a tunnel); one at a time
 *   GET  /agent/status → { busy, state, elapsedMs, reportId?, error? }
 *   POST /agent/cancel → SIGTERMs the running child; its state becomes 'cancelled'
 *   GET  /reports[/:id], DELETE /reports/:id → saved analysis reports (reports/*.json)
 *
 * Env:
 *   MCP_BRIDGE_PORT   default 3001
 *   MCP_BRIDGE_HOST   default 127.0.0.1 (keep loopback; use a tunnel to expose)
 *   MCP_BRIDGE_TOKEN  optional Bearer token. REQUIRED before tunneling the
 *                     bridge (ngrok/cloudflared) — without it anyone with the
 *                     URL controls your TradingView session.
 *   MCP_SERVER_PATH   default <repo>/src/server.js
 *   MCP_BRIDGE_AGENT_MODEL  default 'sonnet' (allowed: sonnet|opus|haiku). Per-run
 *                     override via the POST /agent body; anything else falls back.
 */

import http from 'node:http';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = parseInt(process.env.MCP_BRIDGE_PORT ?? '3001', 10);
const BRIDGE_HOST = process.env.MCP_BRIDGE_HOST ?? '127.0.0.1';
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN ?? '';
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH ?? path.join(__dirname, '..', 'src', 'server.js');
// Agent runs are prompt-driven code execution on this host: opt-in only, and
// NEVER enable behind a tunnel. Token-gated on top of the flag.
const ALLOW_AGENT = process.env.MCP_BRIDGE_ALLOW_AGENT === '1';
const AGENT_TIMEOUT_MS = parseInt(process.env.MCP_BRIDGE_AGENT_TIMEOUT_MS ?? '300000', 10);
const REPORTS_DIR = process.env.MCP_BRIDGE_REPORTS_DIR ?? path.join(__dirname, '..', 'reports');
const CDP_PROBE_URL = 'http://localhost:9222/json/version';
const VIEWER_PATH = path.join(__dirname, 'viewer', 'gate-audit.html');
const CDP_DOWN_RE = /CDP connection failed|not running with CDP|ECONNREFUSED|No TradingView chart target|9222/i;

let mcpProcess = null;
let initialized = false;
const pendingRequests = new Map(); // id → { resolve, reject }
let msgId = 1;

function nextId() { return msgId++; }

function startMCPProcess() {
  if (mcpProcess) return;
  console.log(`[bridge] Spawning MCP server: node ${MCP_SERVER_PATH}`);
  mcpProcess = spawn('node', [MCP_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  mcpProcess.on('exit', (code) => {
    console.log(`[bridge] MCP server exited (code ${code}) — will restart on next request`);
    mcpProcess = null;
    initialized = false;
    for (const [, { reject }] of pendingRequests) {
      reject(new Error('MCP server exited'));
    }
    pendingRequests.clear();
  });

  const rl = readline.createInterface({ input: mcpProcess.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) startMCPProcess();
    const id = nextId();
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    pendingRequests.set(id, { resolve, reject });
    mcpProcess.stdin.write(msg);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }
    }, 30_000);
  });
}

async function ensureInitialized() {
  if (initialized) return;
  startMCPProcess();
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tradingview-mcp-http-bridge', version: '1.0.0' },
  });
  mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  initialized = true;
  console.log('[bridge] MCP server initialized');
}

async function callTool(tool, params) {
  await ensureInitialized();
  const result = await send('tools/call', { name: tool, arguments: params });
  // MCP returns { content: [{ type: 'text', text: '...' }] }
  if (result && result.content) {
    const textPart = result.content.find((c) => c.type === 'text');
    if (textPart) {
      try { return JSON.parse(textPart.text); } catch { return textPart.text; }
    }
  }
  return result;
}

function writeJson(res, status, body) {
  // no-store: /reports and /agent/status change on every add, delete and run.
  // Without this the browser serves a cached list and the UI shows stale reports.
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

// ── agent job (one at a time, buffered — the viewer polls /agent/status) ─────
let agentRun = null; // { id, startedAt, state: 'running'|'done'|'error', reportId?, error? }
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const SAFE_ID = /^[a-z0-9-]+$/;
const reportPath = (id) => path.join(REPORTS_DIR, id + '.json');

function extractTitle(out, prompt) {
  const h = out.match(/^#{1,3} +(.+)$/m);
  return (h ? h[1] : prompt.replace(/^\/\S+\s*/, '')).trim().slice(0, 80) || 'analysis';
}
function extractSummary(out) {
  for (const block of out.split(/\n\s*\n/)) {
    const t = block.trim();
    if (t && !/^#/.test(t) && !/^```/.test(t)) return t.replace(/[*_`]/g, '').slice(0, 400);
  }
  return out.trim().slice(0, 400);
}

// Allowlist: never pass an unvalidated string through as a CLI flag value.
// sonnet reads data and writes prose; opus is for reasoning and code review.
const MODELS = ['sonnet', 'opus', 'haiku'];
const DEFAULT_MODEL = MODELS.includes(process.env.MCP_BRIDGE_AGENT_MODEL) ? process.env.MCP_BRIDGE_AGENT_MODEL : 'sonnet';
const pickModel = (m) => MODELS.includes(m) ? m : DEFAULT_MODEL;

function startAgent(prompt, title, context, model) {
  const id = newId();
  agentRun = { id, startedAt: Date.now(), state: 'running', model };
  // Pinned argv, no shell. mcp__tradingview allows every tool of that server and
  // nothing else; never --dangerously-skip-permissions. MCP_BRIDGE_* is stripped
  // so a run cannot see this bridge's token or recurse into it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_BRIDGE_')));
  const child = spawn('claude', ['-p', prompt, '--model', model, '--allowedTools', 'mcp__tradingview', 'Read', 'Grep', 'Glob'],
    { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  // A killed run exits non-zero, which the handler below would otherwise report as a
  // crash with whatever stderr happens to hold. Record WHY we killed it so a user
  // cancel and a timeout stay distinguishable from a genuine failure.
  let halted = '';
  const halt = (why) => {
    halted = why;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
  };
  const killer = setTimeout(() => halt('timeout'), AGENT_TIMEOUT_MS);
  agentRun.cancel = () => halt('cancelled'); // the only handle on the child; see POST /agent/cancel
  child.on('error', (e) => { clearTimeout(killer); agentRun = { ...agentRun, state: 'error', error: 'claude CLI not runnable: ' + e.message }; });
  child.on('exit', (code) => {
    clearTimeout(killer);
    if (agentRun?.id !== id) return;
    const elapsedMs = Date.now() - agentRun.startedAt;
    if (halted) {
      agentRun = halted === 'cancelled'
        ? { ...agentRun, state: 'cancelled' }
        : { ...agentRun, state: 'error', error: 'timed out after ' + Math.round(AGENT_TIMEOUT_MS / 1000) + 's' };
      console.log(`[bridge] agent run ${id} ${halted}`);
      return;
    }
    if (code !== 0 || !out.trim()) {
      agentRun = { ...agentRun, state: 'error', error: (err || out || 'claude exited ' + code).trim().slice(-800) };
      console.error(`[bridge] agent run ${id} failed (exit ${code})`);
      return;
    }
    const report = {
      id, createdAt: new Date(agentRun.startedAt).toISOString(), type: 'analysis',
      title: title || extractTitle(out, prompt), prompt, context: context || [],
      summary: extractSummary(out), body_md: out.trim(), elapsedMs, model,
    };
    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      writeFileSync(reportPath(id), JSON.stringify(report, null, 2));
      agentRun = { ...agentRun, state: 'done', reportId: id };
      console.log(`[bridge] agent run ${id} done in ${Math.round(elapsedMs / 1000)}s → reports/${id}.json`);
    } catch (e) {
      agentRun = { ...agentRun, state: 'error', error: 'report write failed: ' + e.message };
    }
  });
  return id;
}

function authorized(req) {
  if (!BRIDGE_TOKEN) return true;
  const header = req.headers['authorization'] ?? '';
  return header === `Bearer ${BRIDGE_TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  // Static dashboard — public on purpose: it holds no secrets and prompts for the
  // bearer token itself. Everything below this line stays token-gated.
  if (req.method === 'GET' && pathname === '/viewer') {
    try {
      const html = readFileSync(VIEWER_PATH); // read per request so edits show on reload
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.writeHead(200);
      res.end(html);
    } catch (err) {
      res.setHeader('Content-Type', 'application/json');
      writeJson(res, 500, { error: `viewer not available: ${err.message}` });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  res.setHeader('Content-Type', 'application/json');

  if (!authorized(req)) {
    writeJson(res, 401, { error: 'Unauthorized: set the Authorization: Bearer <MCP_BRIDGE_TOKEN> header' });
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      await ensureInitialized();
      let cdpOk = false;
      try {
        const cdpRes = await fetch(CDP_PROBE_URL, { signal: AbortSignal.timeout(1000) });
        cdpOk = cdpRes.ok;
      } catch { cdpOk = false; }
      if (!cdpOk) {
        writeJson(res, 503, { ok: false, connected: false, agent: ALLOW_AGENT, error: 'TradingView Desktop not running with --remote-debugging-port=9222' });
        return;
      }
      writeJson(res, 200, { ok: true, connected: true, agent: ALLOW_AGENT, defaultModel: DEFAULT_MODEL, models: MODELS, server: MCP_SERVER_PATH });
    } catch (err) {
      writeJson(res, 503, { ok: false, connected: false, agent: ALLOW_AGENT, error: err.message });
    }
    return;
  }

  if (pathname === '/agent' || pathname === '/agent/status' || pathname === '/agent/cancel') {
    if (!ALLOW_AGENT) { writeJson(res, 404, { error: 'agent endpoint disabled — set MCP_BRIDGE_ALLOW_AGENT=1 (local use only, never behind a tunnel)' }); return; }
    if (req.method === 'POST' && pathname === '/agent/cancel') {
      if (!agentRun || agentRun.state !== 'running') { writeJson(res, 409, { error: 'no run in progress', state: agentRun?.state ?? 'idle' }); return; }
      agentRun.cancel();
      writeJson(res, 200, { ok: true, id: agentRun.id });
      return;
    }
    if (req.method === 'GET' && pathname === '/agent/status') {
      writeJson(res, 200, agentRun
        ? { busy: agentRun.state === 'running', id: agentRun.id, state: agentRun.state, model: agentRun.model, elapsedMs: Date.now() - agentRun.startedAt, reportId: agentRun.reportId, error: agentRun.error }
        : { busy: false, state: 'idle' });
      return;
    }
    if (req.method === 'POST' && pathname === '/agent') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let prompt, title, context, model;
        try { ({ prompt, title, context, model } = JSON.parse(body)); } catch { writeJson(res, 400, { error: 'Invalid JSON body — expected { "prompt": "..." }' }); return; }
        if (!prompt || typeof prompt !== 'string') { writeJson(res, 400, { error: 'Missing "prompt"' }); return; }
        if (agentRun && agentRun.state === 'running') { writeJson(res, 409, { error: 'a run is already in progress', id: agentRun.id }); return; }
        const m = pickModel(model);
        writeJson(res, 200, { id: startAgent(prompt, title, context, m), model: m });
      });
      return;
    }
  }

  if (pathname === '/reports' || pathname.startsWith('/reports/')) {
    const id = pathname.slice('/reports/'.length);
    try {
      if (req.method === 'GET' && pathname === '/reports') {
        let files = [];
        try { files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')); } catch {}
        const list = files.map((f) => {
          try { const r = JSON.parse(readFileSync(path.join(REPORTS_DIR, f), 'utf8')); return { id: r.id, createdAt: r.createdAt, type: r.type, title: r.title, summary: r.summary, context: r.context, model: r.model }; }
          catch { return null; }
        }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        writeJson(res, 200, { count: list.length, reports: list });
        return;
      }
      if (!SAFE_ID.test(id)) { writeJson(res, 400, { error: 'bad report id' }); return; }
      if (req.method === 'GET') { writeJson(res, 200, JSON.parse(readFileSync(reportPath(id), 'utf8'))); return; }
      if (req.method === 'DELETE') { unlinkSync(reportPath(id)); writeJson(res, 200, { deleted: id }); return; }
    } catch (err) {
      writeJson(res, err.code === 'ENOENT' ? 404 : 500, { error: err.code === 'ENOENT' ? 'no such report' : err.message });
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/tools') {
    try {
      await ensureInitialized();
      const result = await send('tools/list', {});
      const tools = (result?.tools ?? []).map((t) => ({ name: t.name, description: t.description }));
      writeJson(res, 200, { count: tools.length, tools });
    } catch (err) {
      writeJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/call') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let tool, params;
      try {
        ({ tool, params } = JSON.parse(body));
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body — expected { "tool": "...", "params": { ... } }' });
        return;
      }
      if (!tool || typeof tool !== 'string') {
        writeJson(res, 400, { error: 'Missing "tool" name' });
        return;
      }
      try {
        const data = await callTool(tool, params ?? {});
        if (data && typeof data === 'object' && data.success === false) {
          console.error(`[bridge] tool ${tool} returned error:`, data.error ?? '(unknown)');
          const status = CDP_DOWN_RE.test(String(data.error ?? '')) ? 503 : 500;
          writeJson(res, status, { error: data.error ?? 'MCP tool returned failure' });
          return;
        }
        writeJson(res, 200, data);
      } catch (err) {
        console.error(`[bridge] tool ${tool} threw:`, err.message);
        writeJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  writeJson(res, 404, { error: 'Not found. Endpoints: GET /viewer, GET /health, GET /tools, POST /call, POST /agent, POST /agent/cancel, GET /agent/status, GET|DELETE /reports[/:id]' });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  const port = server.address().port;
  console.log(`[bridge] TradingView MCP HTTP bridge listening on http://${BRIDGE_HOST}:${port}`);
  console.log(`[bridge] Gate Audit viewer: http://${BRIDGE_HOST}:${port}/viewer`);
  console.log(`[bridge] MCP server path: ${MCP_SERVER_PATH}`);
  console.log(`[bridge] agent endpoint: ${ALLOW_AGENT ? `ENABLED (claude -p, default model: ${DEFAULT_MODEL})` : 'disabled (MCP_BRIDGE_ALLOW_AGENT=1 to enable)'}`);
  if (!BRIDGE_TOKEN) {
    console.log('[bridge] WARNING: MCP_BRIDGE_TOKEN is not set. Do NOT expose this port through a tunnel without a token.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (mcpProcess) { try { mcpProcess.kill(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
