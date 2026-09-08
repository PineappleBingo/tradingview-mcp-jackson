#!/usr/bin/env node
/**
 * Minimal stdio JSON-RPC stand-in for src/server.js so scripts/http-bridge.js can be
 * tested without TradingView. Echoes tools/call; `fail_tool` and `cdp_down` simulate errors.
 */
import readline from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Live-chart stand-ins for the Phase 3/4 tests: inputs the sweep job reads and restores,
// and a deterministic RunCard whose numbers depend only on the inputs (so ranking is testable).
const stubInputs = { in_3: 'Soft Filter', in_7: 0.25 };
function stubBacktest(args) {
  let inputs = {};
  try { const c = args.config ? JSON.parse(args.config) : {}; inputs = { ...(c.inputs || {}), ...(args.inputs ? JSON.parse(args.inputs) : {}) }; } catch {}
  const effective = { ...stubInputs, ...inputs };
  const key = JSON.stringify(effective, Object.keys(effective).sort());
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (process.env.STUB_BACKTEST_FAIL === '1') return { success: false, error: 'stub backtest failed' };
  const net = (h % 200) - 60; // −60 … 139, deterministic per input set
  const T0 = Date.now() - 35 * 3600e3; // the window ends now, so a later run extends past an earlier one
  const trades = Array.from({ length: 35 }, (_, i) => {
    const pnl = (i % 3 === 0 ? -4 : 6) + net / 35;
    return { n: i + 1, side: i % 2 ? 'long' : 'short', entryTime: new Date(T0 + i * 3600e3).toISOString(), exitTime: new Date(T0 + i * 3600e3 + 1800e3).toISOString(), pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnl) / 100, cumPnl: 0 };
  });
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const metrics = { netProfit: net, netProfitPct: net / 100, totalTrades: 35, winRate: Math.round(10000 * wins.length / 35) / 100, profitFactor: gl ? Math.round(1000 * gp / gl) / 1000 : null, maxDrawdown: 20, maxDrawdownPct: 2, avgTrade: Math.round(100 * net / 35) / 100, expectancyRatio: 0.5, sharpe: net / 50, sortino: net / 40, calmar: net / 30, maxConsecLosses: 1, long: { trades: 17 }, short: { trades: 18 } };
  const settleMs = Number(process.env.STUB_SETTLE_MS) || 20;
  return { success: true, card: {
    schemaVersion: 1, id: 'bt-' + h.toString(36), createdAt: new Date().toISOString(), kind: 'backtest',
    config: { study: { entityId: 'pf1', name: 'PF 3G stub' }, symbol: 'STUB:SOLUSD', timeframe: '5', inputs, labels: {}, restore: false, splitDate: null, costs: null, configHash: h.toString(16).padStart(8, '0') },
    settled: process.env.STUB_UNSETTLED !== '1', settleMs, warnings: [], window: { firstTradeTime: trades[0].entryTime, lastTradeTime: trades[34].exitTime, tradeCount: 35 },
    metrics, metricSources: {}, tvRaw: {}, trades, equity: { points: [], total: 0, downsampled: false },
    validation: { split: null, monteCarlo: { n: 10, seed: 42, pSharpe: net > 60 ? 0.01 : 0.4, pMaxDD: 0.5 }, bootstrap: {}, walkForward: { nWindows: 5, windows: [], positiveFraction: 0.6, stable: true }, tradeCountPenalty: 1, verdict: net > 60 ? 'edge' : 'noise', reasons: [] },
    body_md: '# stub backtest\n\nnet ' + net, restore: { requested: false, restored: false, changed: Object.keys(inputs), error: null },
  } };
}
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
    else if (name === 'slow_tool') { setTimeout(() => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, slow: true }) }] } }), Number(args.delay_ms) || 1500); return; }
    else if (name === 'chart_get_state') payload = { success: true, symbol: 'STUB:SOLUSD', resolution: '5', studies: [{ id: 'pf1', name: 'PineForge 3rd Gen Volume Profile Strategy [Coinbase]' }] };
    else if (name === 'data_get_indicator') payload = { success: true, entity_id: args.entity_id, inputs: [{ id: 'in_3', value: stubInputs.in_3 }, { id: 'in_7', value: stubInputs.in_7 }] };
    else if (name === 'indicator_set_inputs') { let o = {}; try { o = typeof args.inputs === 'string' ? JSON.parse(args.inputs) : (args.inputs || {}); } catch {} Object.assign(stubInputs, o); payload = { success: true, entity_id: args.entity_id, updated_inputs: o }; }
    else if (name === 'ui_evaluate') payload = { success: true, result: JSON.stringify([{ id: 'in_3', name: 'Trend Gate Mode', type: 'text', options: ['Off', 'Warning Only', 'Soft Filter', 'Hard Filter'], defval: 'Soft Filter', group: 'Costs' }, { id: 'in_7', name: 'ER Range Threshold', type: 'float', min: 0.05, max: 0.6, step: 0.05, defval: 0.25, group: 'Regime' }]) };
    else if (name === 'strategy_run_backtest') payload = stubBacktest(args);
    else payload = { success: true, echo: { tool: name, params: args } };
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
});
process.stdin.on('end', () => process.exit(0));
