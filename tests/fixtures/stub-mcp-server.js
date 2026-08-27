#!/usr/bin/env node
/**
 * Minimal stdio JSON-RPC stand-in for src/server.js so scripts/http-bridge.js can be
 * tested without TradingView. Echoes tools/call; `fail_tool` and `cdp_down` simulate errors.
 */
import readline from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-mcp', version: '0' } } });
  }
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'echo' }, { name: 'strategy_gate_audit', description: 'stub' }] } });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    let payload;
    if (name === 'fail_tool') payload = { success: false, error: 'boom' };
    else if (name === 'cdp_down') payload = { success: false, error: 'CDP connection failed after 5 attempts: fetch failed' };
    else payload = { success: true, echo: { tool: name, params: args } };
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
});
process.stdin.on('end', () => process.exit(0));
