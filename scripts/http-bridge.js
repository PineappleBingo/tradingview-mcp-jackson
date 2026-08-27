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
 *
 * Env:
 *   MCP_BRIDGE_PORT   default 3001
 *   MCP_BRIDGE_HOST   default 127.0.0.1 (keep loopback; use a tunnel to expose)
 *   MCP_BRIDGE_TOKEN  optional Bearer token. REQUIRED before tunneling the
 *                     bridge (ngrok/cloudflared) — without it anyone with the
 *                     URL controls your TradingView session.
 *   MCP_SERVER_PATH   default <repo>/src/server.js
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = parseInt(process.env.MCP_BRIDGE_PORT ?? '3001', 10);
const BRIDGE_HOST = process.env.MCP_BRIDGE_HOST ?? '127.0.0.1';
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN ?? '';
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH ?? path.join(__dirname, '..', 'src', 'server.js');
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
  res.writeHead(status);
  res.end(JSON.stringify(body));
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
        writeJson(res, 503, { ok: false, connected: false, error: 'TradingView Desktop not running with --remote-debugging-port=9222' });
        return;
      }
      writeJson(res, 200, { ok: true, connected: true, server: MCP_SERVER_PATH });
    } catch (err) {
      writeJson(res, 503, { ok: false, connected: false, error: err.message });
    }
    return;
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

  writeJson(res, 404, { error: 'Not found. Endpoints: GET /viewer, GET /health, GET /tools, POST /call' });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  const port = server.address().port;
  console.log(`[bridge] TradingView MCP HTTP bridge listening on http://${BRIDGE_HOST}:${port}`);
  console.log(`[bridge] Gate Audit viewer: http://${BRIDGE_HOST}:${port}/viewer`);
  console.log(`[bridge] MCP server path: ${MCP_SERVER_PATH}`);
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
