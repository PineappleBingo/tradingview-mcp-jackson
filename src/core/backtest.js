/**
 * Phase 3 — one reproducible backtest run around the live Strategy Tester.
 *
 * TradingView stays the only engine. This module adds what every serious backtester wraps
 * around its engine and this repo lacked: a run record (RunConfig → RunCard, hashed for
 * reproducibility — NautilusTrader BacktestRunConfig / Vibe-Trading run_card.py pattern),
 * settle detection after an input change, one consistent snapshot of report + trades +
 * equity, a stable metrics schema with per-key provenance, and the trust layer in
 * ./validate.js. Everything CDP-dependent is injectable through `deps` (same idea as
 * runGateAudit) so the sequence is unit-tested with recorded payloads.
 */
import { createHash } from 'node:crypto';
import { evaluate } from '../connection.js';
import { getIndicator } from './data.js';
import { setInputs } from './indicators.js';
import { getState as getChartState } from './chart.js';
import { testerSignature, waitForTesterSettle } from '../wait.js';
import { computeMetrics, validate, windowOf } from './validate.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_STUDY_RE = /PineForge|PF 3G/i;
const SETTLE_DEFAULTS = { pollMs: 250, stablePolls: 3, timeoutMs: 15000 };
export const MAX_ORDERS = 5000;
export const MAX_EQUITY_POINTS = 2000;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const newId = () => 'bt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

/** Accepts a JSON string or object; fills defaults; clamps settle settings. */
export function normalizeConfig(raw) {
  let c = raw;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { throw new Error('config must be valid JSON'); } }
  c = c && typeof c === 'object' ? { ...c } : {};
  const inputs = c.inputs && typeof c.inputs === 'object' ? { ...c.inputs } : {};
  const settle = { ...SETTLE_DEFAULTS, ...(c.settle || {}) };
  settle.pollMs = Math.max(50, Math.min(5000, Number(settle.pollMs) || SETTLE_DEFAULTS.pollMs));
  settle.stablePolls = Math.max(1, Math.min(10, Number(settle.stablePolls) || SETTLE_DEFAULTS.stablePolls));
  settle.timeoutMs = Math.max(1000, Math.min(60000, Number(settle.timeoutMs) || SETTLE_DEFAULTS.timeoutMs));
  const study = c.study && typeof c.study === 'object' ? { entityId: c.study.entityId ?? null, name: c.study.name ?? null } : { entityId: null, name: c.study_filter ?? null };
  return {
    schemaVersion: SCHEMA_VERSION, study, symbol: c.symbol ?? null, timeframe: c.timeframe ?? null,
    inputs, labels: c.labels && typeof c.labels === 'object' ? { ...c.labels } : {},
    restore: !!c.restore, settle, splitDate: c.splitDate ?? null,
    costs: c.costs && typeof c.costs === 'object' ? { ...c.costs } : null,
  };
}

// Canonical JSON: sorted keys, so two configs that mean the same hash the same. entityId is
// left out on purpose — it changes every session while the run does not.
const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export function configHash(config) {
  const c = normalizeConfig(config);
  const body = { study: c.study.name, symbol: c.symbol, timeframe: c.timeframe, inputs: c.inputs, costs: c.costs };
  return createHash('sha1').update(JSON.stringify(canon(body))).digest('hex');
}

// ── snapshot: report + orders + equity in ONE evaluate ─────────────────────
export const snapshotJS = (maxOrders = MAX_ORDERS, maxEquity = MAX_EQUITY_POINTS) => `
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var strat = null;
      for (var i = 0; i < sources.length; i++) { var s = sources[i]; if (s.metaInfo && (s.ordersData || s.reportData || s.performance)) { strat = s; break; } }
      if (!strat) return { error: 'No strategy found on chart. Add a strategy indicator first.' };
      var unwrap = function(v) { if (v && typeof v === 'object' && typeof v.value === 'function') v = v.value(); return v; };
      var copy = function(o, depth) {
        if (o === null || o === undefined) return null;
        if (typeof o === 'function') return undefined;
        if (typeof o !== 'object') return o;
        if (depth > 2) return undefined;
        if (Array.isArray(o)) { if (depth > 1) return undefined; var arr = []; for (var a = 0; a < Math.min(o.length, 50); a++) { var cv = copy(o[a], depth + 1); if (cv !== undefined) arr.push(cv); } return arr; }
        var out = {}; var ks = Object.keys(o);
        for (var k = 0; k < ks.length; k++) { var v = copy(o[ks[k]], depth + 1); if (v !== undefined) out[ks[k]] = v; }
        return out;
      };
      var rd = null;
      try { rd = copy(unwrap(typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData), 0); } catch (e) { rd = { error: e.message }; }
      if ((!rd || !Object.keys(rd).length) && strat.performance) { try { rd = copy(unwrap(strat.performance()), 0); } catch (e) {} }
      var orders = null;
      try { orders = unwrap(typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData); } catch (e) {}
      if (!Array.isArray(orders)) { try { orders = unwrap(typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData); } catch (e) {} }
      if (!Array.isArray(orders) && strat._orders) orders = strat._orders;
      var total = Array.isArray(orders) ? orders.length : 0;
      var flat = [];
      if (Array.isArray(orders)) {
        var start = Math.max(0, orders.length - ${maxOrders});
        for (var t = start; t < orders.length; t++) {
          var o = orders[t]; if (!o || typeof o !== 'object') continue;
          var trade = {}; var okeys = Object.keys(o);
          for (var q = 0; q < okeys.length; q++) {
            var v = o[okeys[q]];
            if (v === null || v === undefined || typeof v === 'function') continue;
            if (typeof v !== 'object') trade[okeys[q]] = v;
            else if (!Array.isArray(v)) { var nk = Object.keys(v); for (var n = 0; n < nk.length; n++) { var nv = v[nk[n]]; if (nv !== null && nv !== undefined && typeof nv !== 'function' && typeof nv !== 'object') trade[okeys[q] + '_' + nk[n]] = nv; } }
          }
          flat.push(trade);
        }
      }
      var eq = [];
      try {
        var e = unwrap(typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData);
        if (Array.isArray(e)) { for (var x = 0; x < e.length; x++) { var p = e[x]; if (Array.isArray(p)) eq.push({ t: p[0], equity: p[1], dd: p[2] === undefined ? null : p[2] }); else if (p && typeof p === 'object') eq.push({ t: p.time !== undefined ? p.time : p.t, equity: p.value !== undefined ? p.value : (p.equity !== undefined ? p.equity : p.v), dd: p.drawdown !== undefined ? p.drawdown : null }); } }
      } catch (e2) {}
      if (!eq.length && strat.bars) {
        try { var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') { var end = bars.lastIndex(), st0 = bars.firstIndex(); for (var b = st0; b <= end; b++) { var bv = bars.valueAt(b); if (bv) eq.push({ t: bv[0], equity: bv[1], dd: bv[2] === undefined ? null : bv[2] }); } } } catch (e3) {}
      }
      var eqTotal = eq.length, downsampled = false;
      if (eq.length > ${maxEquity}) { var stride = Math.ceil(eq.length / ${maxEquity}); var ds = []; for (var y = 0; y < eq.length; y += stride) ds.push(eq[y]); if (ds[ds.length - 1] !== eq[eq.length - 1]) ds.push(eq[eq.length - 1]); eq = ds; downsampled = true; }
      return { reportData: rd || {}, orders: flat, ordersTotal: total, equity: { points: eq, total: eqTotal, downsampled: downsampled } };
    } catch (e) { return { error: e.message }; }
  })()
`;

export async function readStrategySnapshot({ maxOrders = MAX_ORDERS, maxEquityPoints = MAX_EQUITY_POINTS } = {}) {
  const r = await evaluate(snapshotJS(maxOrders, maxEquityPoints));
  if (!r || r.error) throw new Error(r && r.error ? r.error : 'snapshot returned nothing');
  return r;
}

// ── trades: tolerant mapping of TradingView's flattened order objects ────────
const pick = (o, keys) => { for (const k of keys) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return undefined; };
const toIso = (t) => {
  if (t == null) return null;
  let ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const sideOf = (v) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (/short|sell/.test(s)) return 'short';
  if (/long|buy/.test(s)) return 'long';
  if (v === 1 || s === '1') return 'long';
  if (v === -1 || s === '-1') return 'short';
  return null;
};
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };

export function mapTrades(orders) {
  const rows = (orders || []).map((o) => ({
    side: sideOf(pick(o, ['side', 'direction', 'tradeType', 'trade_type', 'entry_type', 'entryType', 'type', 'entry_side'])),
    entryTime: toIso(pick(o, ['entry_time', 'entryTime', 'entry_barTime', 'entry_bar_time', 'openTime', 'open_time', 'entryBarTime'])),
    exitTime: toIso(pick(o, ['exit_time', 'exitTime', 'exit_barTime', 'exit_bar_time', 'closeTime', 'close_time', 'exitBarTime'])),
    entryPrice: num(pick(o, ['entry_price', 'entryPrice', 'open_price', 'openPrice'])),
    exitPrice: num(pick(o, ['exit_price', 'exitPrice', 'close_price', 'closePrice'])),
    qty: num(pick(o, ['qty', 'quantity', 'size', 'contracts', 'entry_qty', 'exit_qty'])),
    pnl: num(pick(o, ['profit', 'pnl', 'profit_abs', 'profit_v', 'profit_value', 'netProfit', 'net_profit'])),
    pnlPct: num(pick(o, ['profit_percent', 'profit_pct', 'pnl_pct', 'profit_p', 'profitPercent', 'netProfitPercent'])),
    barsHeld: num(pick(o, ['bars', 'barsHeld', 'bars_held', 'duration_bars'])),
    entrySignal: pick(o, ['entry_signal', 'entry_name', 'entry_id', 'entryName']) ?? null,
    exitSignal: pick(o, ['exit_signal', 'exit_name', 'exit_id', 'exitName']) ?? null,
  })).filter((t) => t.pnl !== undefined || t.entryTime);
  rows.sort((a, b) => (Date.parse(a.entryTime || 0) || 0) - (Date.parse(b.entryTime || 0) || 0));
  let cum = 0;
  return rows.map((t, i) => { cum += t.pnl || 0; return { n: i + 1, ...t, cumPnl: Math.round(cum * 100) / 100 }; });
}

// ── TradingView report keys → schema (best-effort; confirmed live at phase start) ─
export const TV_KEYS = {
  netProfit: ['netProfit', 'net_profit'], netProfitPct: ['netProfitPercent', 'netProfitPct', 'net_profit_percent'],
  grossProfit: ['grossProfit', 'gross_profit'], grossLoss: ['grossLoss', 'gross_loss'],
  totalTrades: ['totalTrades', 'total_trades', 'numberOfTrades', 'trades'],
  winRate: ['percentProfitable', 'percent_profitable', 'winRate', 'win_rate'],
  profitFactor: ['profitFactor', 'profit_factor'],
  maxDrawdown: ['maxStrategyDrawDown', 'maxDrawdown', 'maxDrawDown', 'max_drawdown', 'maxStrategyDrawdown'],
  maxDrawdownPct: ['maxStrategyDrawDownPercent', 'maxDrawdownPercent', 'maxDrawDownPercent', 'max_drawdown_percent'],
  avgTrade: ['avgTrade', 'avg_trade'], avgTradePct: ['avgTradePercent', 'avg_trade_percent'],
  avgWin: ['avgWinTrade', 'avg_win_trade', 'avgWin'], avgLoss: ['avgLosTrade', 'avgLossTrade', 'avg_loss_trade', 'avgLoss'],
  maxConsecLosses: ['maxConsecutiveLosses', 'max_consecutive_losses', 'maxLosingStreak'],
  sharpe: ['sharpeRatio', 'sharpe_ratio', 'sharpe'], sortino: ['sortinoRatio', 'sortino_ratio', 'sortino'],
};
const ABS_KEYS = new Set(['avgLoss', 'grossLoss', 'maxDrawdown', 'maxDrawdownPct']);
const DD_KEYS = new Set(['maxDrawdown', 'maxDrawdownPct']);
// Ratios are convention-bound (TradingView annualises monthly returns; ours is trade-based),
// so a disagreement there is expected and never a mismatch: TV wins when present.
const NO_COMPARE = new Set(['sharpe', 'sortino', 'calmar', 'expectancyRatio']);

const unwrapTv = (v) => {
  if (v == null) return { all: null };
  if (typeof v === 'number') return { all: v };
  if (typeof v === 'object') {
    if (typeof v.all === 'number' || v.all != null) return { all: num(v.all) ?? null, long: num(v.long) ?? null, short: num(v.short) ?? null };
    if (v.value !== undefined) return { all: num(v.value) ?? null };
    if (v.v !== undefined) return { all: num(v.v) ?? null };
  }
  return { all: num(v) ?? null };
};

export function tvMetrics(reportData) {
  const out = { metrics: {}, long: {}, short: {}, found: [] };
  if (!reportData || typeof reportData !== 'object') return out;
  for (const [key, cands] of Object.entries(TV_KEYS)) {
    for (const c of cands) {
      if (reportData[c] === undefined) continue;
      const u = unwrapTv(reportData[c]);
      if (u.all == null) continue;
      let v = u.all;
      if (key === 'winRate' && v <= 1) { v = v * 100; } // fraction → percent
      if (ABS_KEYS.has(key)) v = Math.abs(v);
      if (key === 'avgLoss') v = -Math.abs(v);
      out.metrics[key] = v; out.found.push(c);
      if (u.long != null) out.long[key] = u.long;
      if (u.short != null) out.short[key] = u.short;
      break;
    }
  }
  return out;
}

const SCHEMA_KEYS = ['netProfit', 'netProfitPct', 'totalTrades', 'winRate', 'profitFactor', 'maxDrawdown', 'maxDrawdownPct', 'avgTrade', 'avgTradePct', 'avgWin', 'avgLoss', 'expectancyRatio', 'sharpe', 'sortino', 'calmar', 'maxConsecLosses', 'grossProfit', 'grossLoss'];

/**
 * Two sources, one schema. The tester is the engine of record, the recomputation from the
 * trade list is the audit: when both exist and disagree beyond tolerance the TV value is kept
 * and a `metrics_mismatch:<key>` warning is raised. Drawdown gets 5 % because TradingView's
 * includes open P&L bar by bar while ours is closed-trade.
 */
export function normalizeMetrics(tvRaw, trades, costs) {
  const tv = tvMetrics(tvRaw);
  const comp = computeMetrics(trades, { initialCapital: costs && costs.initialCapital });
  const metrics = {}, metricSources = {}, warnings = [];
  for (const key of SCHEMA_KEYS) {
    const a = tv.metrics[key], b = comp[key];
    const hasA = typeof a === 'number' && Number.isFinite(a), hasB = typeof b === 'number' && Number.isFinite(b);
    if (hasA && hasB && NO_COMPARE.has(key)) { metrics[key] = a; metricSources[key] = 'tv'; }
    else if (hasA && hasB) {
      const x = ABS_KEYS.has(key) ? Math.abs(a) : a, y = ABS_KEYS.has(key) ? Math.abs(b) : b;
      const tol = DD_KEYS.has(key) ? Math.max(0.05 * Math.abs(x), 0.5) : Math.max(0.01 * Math.abs(x), 0.5);
      if (Math.abs(x - y) <= tol) metricSources[key] = 'both';
      else { metricSources[key] = 'tv'; warnings.push('metrics_mismatch:' + key); }
      metrics[key] = a;
    } else if (hasA) { metrics[key] = a; metricSources[key] = 'tv'; }
    else if (hasB) { metrics[key] = b; metricSources[key] = 'computed'; }
    else { metrics[key] = null; metricSources[key] = 'none'; }
  }
  metrics.long = { ...comp.long, ...(Object.keys(tv.long).length ? { tv: tv.long } : {}) };
  metrics.short = { ...comp.short, ...(Object.keys(tv.short).length ? { tv: tv.short } : {}) };
  if (trades.length && trades.every((t) => typeof t.pnl !== 'number')) warnings.push('trades_unmapped');
  if (trades.length && trades.length < 30) warnings.push('few_trades');
  return { metrics, metricSources, warnings, computed: comp, tvFound: tv.found };
}

// ── markdown body (what the Reports tab renders) ───────────────────────────
const f2 = (v, suffix = '') => v == null ? '–' : (Math.round(v * 100) / 100).toString() + suffix;
export function renderRunCardMd(card) {
  const m = card.metrics || {}, v = card.validation || {}, c = card.config || {};
  const lines = [
    `# Backtest · ${c.symbol || '?'} · ${c.timeframe || '?'} · ${(c.study && c.study.name) || 'strategy'}`,
    '',
    `${card.settled ? 'settled in ' + Math.round((card.settleMs || 0) / 1000 * 10) / 10 + ' s' : 'UNSETTLED (values may be stale)'} · ${card.window ? card.window.tradeCount : 0} trades · config ${String(c.configHash || '').slice(0, 10)}`,
    Object.keys(c.inputs || {}).length ? 'overrides: ' + Object.entries(c.inputs).map(([k, val]) => ((c.labels && c.labels[k]) || k) + '=' + val).join(', ') : 'overrides: none (chart as-is)',
    '',
    `**Verdict: ${(v.verdict || 'n/a').toUpperCase()}** — ${(v.reasons || []).join('; ') || 'no validation'}`,
    '',
    '| Metric | Value | Source |', '|---|---|---|',
    `| Net profit | ${f2(m.netProfit)} (${f2(m.netProfitPct, ' %')}) | ${card.metricSources?.netProfit || ''} |`,
    `| Total trades | ${m.totalTrades ?? '–'} | ${card.metricSources?.totalTrades || ''} |`,
    `| Win rate | ${f2(m.winRate, ' %')} | ${card.metricSources?.winRate || ''} |`,
    `| Profit factor | ${f2(m.profitFactor)} | ${card.metricSources?.profitFactor || ''} |`,
    `| Max drawdown | ${f2(m.maxDrawdown)} (${f2(m.maxDrawdownPct, ' %')}) | ${card.metricSources?.maxDrawdown || ''} |`,
    `| Avg trade | ${f2(m.avgTrade)} (${f2(m.avgTradePct, ' %')}) | ${card.metricSources?.avgTrade || ''} |`,
    `| Long / short | ${m.long ? m.long.trades : '–'} / ${m.short ? m.short.trades : '–'} | computed |`,
    `| Sharpe / Sortino / Calmar | ${f2(m.sharpe)} / ${f2(m.sortino)} / ${f2(m.calmar)} | ${card.metricSources?.sharpe || ''} |`,
    `| Expectancy ratio | ${f2(m.expectancyRatio)} | ${card.metricSources?.expectancyRatio || ''} |`,
    `| Max consecutive losses | ${m.maxConsecLosses ?? '–'} | ${card.metricSources?.maxConsecLosses || ''} |`,
  ];
  if (v.split) lines.push('', `IS (${v.split.is.n} trades, before ${v.split.splitDate.slice(0, 10)}): net ${f2(v.split.is.netProfit)} · PF ${f2(v.split.is.profitFactor)} — OOS (${v.split.oos.n} trades): net ${f2(v.split.oos.netProfit)} · PF ${f2(v.split.oos.profitFactor)}`);
  if (v.monteCarlo) lines.push(`Monte-Carlo (n=${v.monteCarlo.n}): pSharpe ${v.monteCarlo.pSharpe ?? '–'} · pMaxDD ${v.monteCarlo.pMaxDD ?? '–'} · pPF ${v.monteCarlo.pProfitFactor ?? '–'}`);
  if (v.bootstrap) lines.push(`Bootstrap Sharpe 95 %: [${v.bootstrap.sharpeLo ?? '–'}, ${v.bootstrap.sharpeHi ?? '–'}] · P(mean>0) ${v.bootstrap.pPositive ?? '–'}`);
  if (v.walkForward) lines.push(`Walk-forward: ${v.walkForward.windows.filter((w) => w.netProfit > 0).length}/${v.walkForward.nWindows} windows positive${v.walkForward.stable ? ' (stable)' : ''}`);
  if (card.warnings && card.warnings.length) lines.push('', 'Warnings: ' + card.warnings.join(', '));
  const tr = (card.trades || []).slice(0, 20);
  if (tr.length) {
    lines.push('', '| # | side | entry | exit | P&L | % |', '|---|---|---|---|---|---|');
    for (const t of tr) lines.push(`| ${t.n} | ${t.side || '?'} | ${(t.entryTime || '').slice(5, 16).replace('T', ' ')} | ${(t.exitTime || '').slice(5, 16).replace('T', ' ')} | ${f2(t.pnl)} | ${f2(t.pnlPct)} |`);
  }
  return lines.join('\n');
}

// ── the run ────────────────────────────────────────────────────────────────
export async function runBacktest(rawConfig, deps = {}) {
  const d = { getChartState, getIndicator, setInputs, testerSignature, waitForTesterSettle, readStrategySnapshot, now: Date.now, ...deps };
  const config = normalizeConfig(rawConfig);
  const warnings = [];
  const startedAt = d.now();

  // 1. resolve the study
  const st = await d.getChartState();
  const studies = (st && st.studies) || [];
  const re = config.study.name ? new RegExp(escapeRe(config.study.name), 'i') : DEFAULT_STUDY_RE;
  const study = studies.find((s) => config.study.entityId && (s.id === config.study.entityId || s.entity_id === config.study.entityId))
    || studies.find((s) => re.test(s.name || s.title || s.description || ''));
  if (!study) return { success: false, error: `strategy study not found on chart (looked for ${config.study.name || 'PineForge|PF 3G'})` };
  const entityId = study.id || study.entity_id;
  config.study = { entityId, name: study.name || study.title || config.study.name };
  config.symbol = config.symbol || st.symbol || null;
  config.timeframe = config.timeframe || st.resolution || st.timeframe || null;
  config.configHash = configHash(config);

  // 2. snapshot originals; skip the wait when nothing actually changes
  const ids = Object.keys(config.inputs);
  const original = {};
  if (ids.length) {
    const ind = await d.getIndicator({ entity_id: entityId });
    for (const i of ind.inputs || []) if (ids.includes(i.id)) original[i.id] = i.value;
    for (const id of ids) if (!(id in original)) warnings.push('inputs_not_applied:' + id);
  }
  const changed = ids.filter((id) => id in original && String(original[id]) !== String(config.inputs[id]));
  let settled = true, settleMs = 0, settleInfo = null;
  if (ids.length && !changed.length) warnings.push('no_change');
  if (changed.length) {
    const before = await d.testerSignature();
    const apply = Object.fromEntries(changed.map((id) => [id, config.inputs[id]]));
    const res = await d.setInputs({ entity_id: entityId, inputs: apply });
    for (const id of changed) if (!(res && res.updated_inputs && id in res.updated_inputs)) warnings.push('inputs_not_applied:' + id);
    settleInfo = await d.waitForTesterSettle({ before, ...config.settle });
    settled = !!settleInfo.settled; settleMs = settleInfo.settleMs || 0;
    if (!settled) warnings.push('unsettled');
  }

  const restore = { requested: !!config.restore, restored: false, changed, error: null };
  try {
    // 3. one consistent snapshot, then normalise and validate
    const snap = await d.readStrategySnapshot({ maxOrders: MAX_ORDERS, maxEquityPoints: MAX_EQUITY_POINTS });
    const trades = mapTrades(snap.orders || []);
    if (snap.ordersTotal > (snap.orders || []).length) warnings.push('trades_truncated');
    const equity = snap.equity || { points: [], total: 0, downsampled: false };
    if (!equity.points || !equity.points.length) warnings.push('no_equity');
    const norm = normalizeMetrics(snap.reportData, trades, config.costs);
    for (const w of norm.warnings) if (!warnings.includes(w)) warnings.push(w);
    const validation = validate(trades, { splitDate: config.splitDate, initialCapital: config.costs && config.costs.initialCapital, settled });
    const card = {
      schemaVersion: SCHEMA_VERSION, id: newId(), createdAt: new Date(startedAt).toISOString(), kind: 'backtest',
      config, settled, settleMs, warnings, window: windowOf(trades),
      metrics: norm.metrics, metricSources: norm.metricSources, computedMetrics: norm.computed, tvRaw: snap.reportData || {},
      trades, equity, validation, restore, elapsedMs: d.now() - startedAt,
    };
    card.body_md = renderRunCardMd(card);
    return { success: true, card };
  } finally {
    if (config.restore && changed.length) {
      try { await d.setInputs({ entity_id: entityId, inputs: Object.fromEntries(changed.map((id) => [id, original[id]])) }); restore.restored = true; }
      catch (e) { restore.error = e.message; }
    }
  }
}
