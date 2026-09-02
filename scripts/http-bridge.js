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
 *   POST /agent/cancel → SIGTERMs the running child; its state becomes 'cancelled'\n *   POST /agent/resume → continues a timed-out run in its own claude session
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
 *   MCP_BRIDGE_AGENT_TIMEOUT_MS  default 900000 (15 min). A two-timeframe opus audit
 *                     measured 257s, so 300s left almost no headroom. On timeout the run
 *                     is kept resumable rather than discarded.
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
const AGENT_TIMEOUT_MS = parseInt(process.env.MCP_BRIDGE_AGENT_TIMEOUT_MS ?? '900000', 10);
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
// state: 'running' | 'done' | 'error' | 'cancelled' | 'timeout'
// 'timeout' is deliberately NOT 'error': the child's session survives on disk, so the
// run is resumable via POST /agent/resume rather than thrown away.
let agentRun = null;
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const SAFE_ID = /^[a-z0-9-]+$/;
const reportPath = (id) => path.join(REPORTS_DIR, id + '.json');

// endedAt freezes the clock. Computing this as `Date.now() - startedAt` unconditionally
// made a finished run's elapsed keep climbing (a run killed at 300s reported 575s), which
// reads as "the child never died".
const elapsedOf = (r) => (r.endedAt ?? Date.now()) - r.startedAt;

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

// Task lets the run delegate a large tool payload to a subagent that returns a digest —
// the skill decides when that is worth it. A subagent inherits this same allowlist, so
// this adds instances, not permissions. Never --dangerously-skip-permissions.
const AGENT_TOOLS = ['mcp__tradingview', 'Read', 'Grep', 'Glob', 'Task'];

// Progress baseline: the median of past runs for this model. A model cannot know how much
// work remains, so the viewer's bar is elapsed against lived experience — and says so.
const FALLBACK_MS = { haiku: 30000, sonnet: 60000, opus: 260000 };
function expectedMsFor(model) {
  const times = [];
  try {
    for (const f of readdirSync(REPORTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        if (r.model === model && r.elapsedMs > 0) times.push(r.elapsedMs);
      } catch {}
    }
  } catch {}
  if (!times.length) return FALLBACK_MS[model] ?? 120000;
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const friendlyTool = (name, input) => {
  const n = String(name || '').replace(/^mcp__tradingview__/, '').replace(/_/g, ' ');
  if (n === 'Task') return 'delegating to a subagent';
  const f = input && (input.study_filter || input.symbol || input.region);
  return f ? n + ' · ' + f : n;
};

// One stream-json event. Captures the session id (first event carries it — that is what
// makes resume possible), which tool is running, and a token counter. Together these are
// what tell a watcher "still working" apart from "hung".
function consumeEvent(id, j) {
  if (agentRun?.id !== id) return;
  if (j.session_id && !agentRun.sessionId) agentRun.sessionId = j.session_id;
  if (j.type === 'system' && j.subtype === 'thinking_tokens' && typeof j.estimated_tokens === 'number') {
    agentRun.tokens = j.estimated_tokens;
  }
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    for (const c of j.message.content) {
      if (c.type !== 'tool_use') continue;
      agentRun.step = (agentRun.step || 0) + 1;
      agentRun.stepLabel = friendlyTool(c.name, c.input);
    }
  }
  if (j.type === 'result') {
    if (typeof j.result === 'string') agentRun.resultText = j.result;
    agentRun.costUsd = j.total_cost_usd;
    agentRun.subagents = j.subagent_stats;
  }
}

// Shared by a fresh run and by a resume: spawn, parse the stream, settle the run.
function runClaude(id, args, meta) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MCP_BRIDGE_')));
  const child = spawn('claude', args, { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', buf = '', lastRaw = '';
  child.stdout.on('data', (d) => {
    buf += d;
    lastRaw = (lastRaw + d).slice(-2000); // kept only so a timeout can show what it was doing
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      consumeEvent(id, j);
    }
  });
  child.stderr.on('data', (d) => { err += d; });

  // A killed run exits non-zero, which the handler below would otherwise report as a crash
  // with whatever stderr happens to hold. Record WHY we killed it so a user cancel and a
  // timeout stay distinguishable from a genuine failure.
  let halted = '';
  const halt = (why) => {
    halted = why;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
  };
  const killer = setTimeout(() => halt('timeout'), AGENT_TIMEOUT_MS);
  agentRun.cancel = () => halt('cancelled'); // the only handle on the child; see POST /agent/cancel

  child.on('error', (e) => {
    clearTimeout(killer);
    if (agentRun?.id !== id) return;
    agentRun = { ...agentRun, state: 'error', endedAt: Date.now(), error: 'claude CLI not runnable: ' + e.message };
  });
  child.on('exit', (code) => {
    clearTimeout(killer);
    if (agentRun?.id !== id) return;
    const endedAt = Date.now();
    const elapsedMs = endedAt - agentRun.startedAt;

    if (halted === 'cancelled') {
      agentRun = { ...agentRun, state: 'cancelled', endedAt };
      console.log(`[bridge] agent run ${id} cancelled`);
      return;
    }
    if (halted === 'timeout') {
      // Keep sessionId (resume) and the tail (diagnosis). Discarding both is what made the
      // previous timeout impossible to tell apart from a hang.
      agentRun = { ...agentRun, state: 'timeout', endedAt,
        error: 'timed out after ' + Math.round(AGENT_TIMEOUT_MS / 1000) + 's'
          + (agentRun.stepLabel ? ' during: ' + agentRun.stepLabel : ''),
        ...(err.trim() ? { tail: err.trim().slice(-800) } : {}) };
      console.error(`[bridge] agent run ${id} timed out (resumable: ${!!agentRun.sessionId})`);
      return;
    }

    const out = (agentRun.resultText || '').trim();
    if (code !== 0 || !out) {
      agentRun = { ...agentRun, state: 'error', endedAt,
        error: (err || lastRaw || 'claude exited ' + code).trim().slice(-800) };
      console.error(`[bridge] agent run ${id} failed (exit ${code})`);
      return;
    }
    const report = {
      id, createdAt: new Date(agentRun.startedAt).toISOString(), type: 'analysis',
      title: meta.title || extractTitle(out, meta.prompt), prompt: meta.prompt, context: meta.context || [],
      summary: extractSummary(out), body_md: out, elapsedMs, model: meta.model,
      ...(meta.resumedFrom ? { resumedFrom: meta.resumedFrom } : {}),
      ...(agentRun.costUsd ? { costUsd: agentRun.costUsd } : {}),
    };
    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      writeFileSync(reportPath(id), JSON.stringify(report, null, 2));
      agentRun = { ...agentRun, state: 'done', endedAt, reportId: id };
      console.log(`[bridge] agent run ${id} done in ${Math.round(elapsedMs / 1000)}s → reports/${id}.json`);
    } catch (e) {
      agentRun = { ...agentRun, state: 'error', endedAt, error: 'report write failed: ' + e.message };
    }
  });
}

const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose'];

function startAgent(prompt, title, context, model) {
  const id = newId();
  agentRun = { id, startedAt: Date.now(), state: 'running', model, step: 0, tokens: 0,
    expectedMs: expectedMsFor(model), title, prompt, context };
  runClaude(id, ['-p', prompt, '--model', model, '--allowedTools', ...AGENT_TOOLS, ...STREAM_ARGS],
    { title, prompt, context, model });
  return id;
}

// Continue a timed-out run in its own session rather than starting over. Resume is
// turn-granular: it picks up from the last completed turn on disk, not the exact instant
// the child was killed.
function resumeAgent(prev) {
  const id = newId();
  agentRun = { id, startedAt: Date.now(), state: 'running', model: prev.model, step: 0, tokens: 0,
    expectedMs: expectedMsFor(prev.model), sessionId: prev.sessionId, resumedFrom: prev.id,
    title: prev.title, prompt: prev.prompt, context: prev.context };
  runClaude(id, ['-p', 'Continue where you left off and produce the final report.',
    '--resume', prev.sessionId, '--model', prev.model, '--allowedTools', ...AGENT_TOOLS, ...STREAM_ARGS],
    { title: prev.title, prompt: prev.prompt, context: prev.context, model: prev.model, resumedFrom: prev.id });
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

  if (pathname === '/agent' || pathname === '/agent/status' || pathname === '/agent/cancel' || pathname === '/agent/resume') {
    if (!ALLOW_AGENT) { writeJson(res, 404, { error: 'agent endpoint disabled — set MCP_BRIDGE_ALLOW_AGENT=1 (local use only, never behind a tunnel)' }); return; }
    if (req.method === 'POST' && pathname === '/agent/resume') {
      if (!agentRun || agentRun.state !== 'timeout') { writeJson(res, 409, { error: 'no timed-out run to continue', state: agentRun?.state ?? 'idle' }); return; }
      if (!agentRun.sessionId) { writeJson(res, 409, { error: 'run has no session id — it died before the session opened; use retry' }); return; }
      const prev = agentRun; // resumeAgent reassigns the global; capture before calling
      writeJson(res, 200, { id: resumeAgent(prev), model: prev.model, resumedFrom: prev.id });
      return;
    }
    if (req.method === 'POST' && pathname === '/agent/cancel') {
      if (!agentRun || agentRun.state !== 'running') { writeJson(res, 409, { error: 'no run in progress', state: agentRun?.state ?? 'idle' }); return; }
      agentRun.cancel();
      writeJson(res, 200, { ok: true, id: agentRun.id });
      return;
    }
    if (req.method === 'GET' && pathname === '/agent/status') {
      writeJson(res, 200, agentRun
        ? {
            busy: agentRun.state === 'running', id: agentRun.id, state: agentRun.state,
            model: agentRun.model, elapsedMs: elapsedOf(agentRun), expectedMs: agentRun.expectedMs,
            step: agentRun.step || 0, stepLabel: agentRun.stepLabel, tokens: agentRun.tokens || 0,
            resumable: agentRun.state === 'timeout' && !!agentRun.sessionId,
            reportId: agentRun.reportId, error: agentRun.error, tail: agentRun.tail,
          }
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

  writeJson(res, 404, { error: 'Not found. Endpoints: GET /viewer, GET /health, GET /tools, POST /call, POST /agent, POST /agent/cancel, POST /agent/resume, GET /agent/status, GET|DELETE /reports[/:id]' });
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
