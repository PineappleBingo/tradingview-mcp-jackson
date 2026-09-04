/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS } from '../connection.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 200;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// JSON-escape a value for safe interpolation into injected page JS. Raw
// '${...}' interpolation breaks on quotes/backslashes and enables injection.
export const jsStr = (s) => JSON.stringify(String(s ?? ''));

// ── Strategy Tester access (shared by the readers below, the settle signature in
// src/wait.js and the Phase 3 snapshot in ./backtest.js) ─────────────────────────
// Verified live on TradingView Desktop 3.4.0 (2026-09-04):
//  - EVERY study carries a `performance` watched value, so the old
//    `ordersData || reportData || performance` scan matched the Volume indicator.
//    The model names the strategy directly (activeStrategySource); the fallback scans
//    metaInfo().isTVScriptStrategy. An indicator() script never qualifies.
//  - reportData() nests the metrics under performance.{all,long,short} plus a few
//    top-level ratios (maxStrategyDrawDown, sharpeRatio, …); every *Percent value and
//    percentProfitable is a FRACTION (0.05 = 5 %).
//  - The closed-trade list is reportData().trades ({e,x,q,tp,cp,rn,dd,cm}, times in ms);
//    ordersData() is the raw fill list keyed by bar index. buyHold[0] is the initial capital.
export const strategySourceJS = (entityId = null) => `(function() {
  var model = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model();
  var want = ${jsStr(entityId)};
  var isStrat = function(s) { try { var mi = typeof s.metaInfo === 'function' ? s.metaInfo() : s.metaInfo; return !!(mi && mi.isTVScriptStrategy && typeof s.reportData === 'function'); } catch (e) { return false; } };
  var sources = model.dataSources();
  if (want) { for (var i = 0; i < sources.length; i++) { var s = sources[i]; try { if (typeof s.id === 'function' && s.id() === want) return isStrat(s) ? s : null; } catch (e) {} } return null; }
  try { var a = model.activeStrategySource && model.activeStrategySource(); a = a && typeof a.value === 'function' ? a.value() : a; if (a && isStrat(a)) return a; } catch (e) {}
  for (var j = 0; j < sources.length; j++) if (isStrat(sources[j])) return sources[j];
  return null;
})()`;

// Page-side function source: (strat, maxTrades) → { report, trades, tradesTotal, openTrades }.
// report = { <perf.all key>: {all,long,short}, <top-level ratio>: number, currency, dateRange, initialCapital }
// trades = the LAST maxTrades rows (null = all, 0 = none), one level flattened (e_tm, x_p, tp_v, …),
//          the still-open ones flagged `open` — TradingView lists them but excludes them from netProfit.
export const REPORT_FLATTEN_JS = `function(strat, maxTrades) {
  var unwrap = function(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; };
  var rd = unwrap(typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) || {};
  var perf = rd.performance || {}, all = perf.all || {}, lng = perf.long || {}, sht = perf.short || {};
  var report = {};
  Object.keys(perf).forEach(function(k) { if (typeof perf[k] === 'number') report[k] = perf[k]; });
  Object.keys(all).forEach(function(k) { if (typeof all[k] === 'number') report[k] = { all: all[k], long: typeof lng[k] === 'number' ? lng[k] : null, short: typeof sht[k] === 'number' ? sht[k] : null }; });
  if (rd.currency) report.currency = rd.currency;
  if (rd.settings && rd.settings.dateRange) report.dateRange = rd.settings.dateRange;
  if (Array.isArray(rd.buyHold) && typeof rd.buyHold[0] === 'number') report.initialCapital = rd.buyHold[0];
  var list = Array.isArray(rd.trades) ? rd.trades : [], total = list.length;
  var open = typeof all.totalOpenTrades === 'number' ? all.totalOpenTrades : 0;
  var take = maxTrades == null ? total : Math.max(0, Math.min(total, maxTrades)), trades = [];
  for (var t = total - take; t < total; t++) {
    var o = list[t]; if (!o || typeof o !== 'object') continue;
    var tr = {}, ks = Object.keys(o);
    for (var q = 0; q < ks.length; q++) { var v = o[ks[q]]; if (v === null || v === undefined || typeof v === 'function') continue;
      if (typeof v !== 'object') tr[ks[q]] = v;
      else if (!Array.isArray(v)) { var nk = Object.keys(v); for (var n = 0; n < nk.length; n++) { var nv = v[nk[n]]; if (nv !== null && nv !== undefined && typeof nv !== 'function' && typeof nv !== 'object') tr[ks[q] + '_' + nk[n]] = nv; } } }
    if (t >= total - open) tr.open = true;
    trades.push(tr);
  }
  return { report: report, trades: trades, tradesTotal: total, openTrades: open };
}`;

// ── trades: TradingView's flattened trade rows → one schema ────────────────────
const pick = (o, keys) => { for (const k of keys) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return undefined; };
const toIso = (t) => { if (t == null) return null; const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const sideOf = (v) => {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s === 'se' || s === 'sx' || /short|sell/.test(s)) return 'short';
  if (s === 'le' || s === 'lx' || /long|buy/.test(s)) return 'long';
  if (v === 1 || s === '1') return 'long';
  if (v === -1 || s === '-1') return 'short';
  return null;
};
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };

/**
 * reportData().trades rows as flattened by REPORT_FLATTEN_JS (e_tm/x_tm/tp_v/…, recorded live)
 * come first; any other shape falls through to the tolerant key search. Sorted by entry time,
 * numbered, with a running cumPnl. Open trades keep `open:true` and no exit.
 */
export function mapTrades(orders) {
  const rows = (orders || []).map((o) => {
    if (o && typeof o === 'object' && (o.e_tm !== undefined || o.x_tm !== undefined)) {
      const pct = num(o.tp_p);
      return {
        side: sideOf(o.e_tp) ?? sideOf(o.e_c), entryTime: toIso(o.e_tm), exitTime: o.open ? null : toIso(o.x_tm),
        entryPrice: num(o.e_p), exitPrice: o.open ? undefined : num(o.x_p), qty: num(o.q),
        pnl: num(o.tp_v), pnlPct: pct === undefined ? undefined : pct * 100,
        barsHeld: num(o.x_b) !== undefined && num(o.e_b) !== undefined ? o.x_b - o.e_b : undefined,
        entrySignal: o.e_c || null, exitSignal: o.x_c || null, runUp: num(o.rn_v), drawdown: num(o.dd_v), commission: num(o.cm),
        ...(o.open ? { open: true } : {}),
      };
    }
    return {
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
    };
  }).filter((t) => t.pnl !== undefined || t.entryTime);
  rows.sort((a, b) => (Date.parse(a.entryTime || 0) || 0) - (Date.parse(b.entryTime || 0) || 0));
  let cum = 0;
  return rows.map((t, i) => { cum += t.pnl || 0; return { n: i + 1, ...t, cumPnl: Math.round(cum * 100) / 100 }; });
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${jsStr(filter)}.toLowerCase();
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.toLowerCase().indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                // The inner Map is keyed by a boolean layer flag. It was hardcoded to
                // false, which reads an empty layer — on TradingView Desktop 3.4 the
                // drawings live under true, so every pine graphics tool returned 0.
                // Iterate the real keys instead of guessing one.
                inner.forEach(function(coll) {
                  if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                    coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                  }
                });
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${jsStr(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${jsStr(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  const r = await evaluate(`
    (function() {
      try {
        var strat = ${strategySourceJS()};
        if (!strat) return { error: 'No strategy found on chart. Add a strategy — an indicator() script has no Strategy Tester report.' };
        var f = (${REPORT_FLATTEN_JS})(strat, 0);
        var metrics = {}, long = {}, short = {};
        Object.keys(f.report).forEach(function(k) { var v = f.report[k]; if (v && typeof v === 'object' && 'all' in v) { metrics[k] = v.all; if (v.long != null) long[k] = v.long; if (v.short != null) short[k] = v.short; } else metrics[k] = v; });
        return { metrics: metrics, long: long, short: short, trade_count: f.tradesTotal, open_trades: f.openTrades };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (!r || r.error) return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, error: r?.error ?? 'no result' };
  return { success: true, metric_count: Object.keys(r.metrics).length, source: 'internal_api', metrics: r.metrics, long: r.long, short: r.short, trade_count: r.trade_count, open_trades: r.open_trades, note: 'percent fields (*Percent, percentProfitable) are fractions: 0.05 = 5 %' };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const r = await evaluate(`
    (function() {
      try {
        var strat = ${strategySourceJS()};
        if (!strat) return { error: 'No strategy found on chart. Add a strategy — an indicator() script has no trade list.' };
        var f = (${REPORT_FLATTEN_JS})(strat, ${limit});
        return { trades: f.trades, total: f.tradesTotal, open: f.openTrades };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (!r || r.error) return { success: true, trade_count: 0, source: 'internal_api', trades: [], error: r?.error ?? 'no result' };
  const trades = mapTrades(r.trades);
  return { success: true, trade_count: trades.length, total_trades: r.total, open_trades: r.open, source: 'internal_api', trades, note: 'most recent ' + trades.length + ' of ' + r.total + ' (newest last)' };
}

export async function getEquity() {
  const r = await evaluate(`
    (function() {
      try {
        var strat = ${strategySourceJS()};
        if (!strat) return { error: 'No strategy found on chart.' };
        var f = (${REPORT_FLATTEN_JS})(strat, null);
        var cap = typeof f.report.initialCapital === 'number' ? f.report.initialCapital : 0, data = [];
        for (var i = 0; i < f.trades.length; i++) { var t = f.trades[i]; if (t.open || typeof t.cp_v !== 'number') continue; data.push({ time: typeof t.x_tm === 'number' ? Math.round(t.x_tm / 1000) : null, equity: cap + t.cp_v, drawdown: typeof t.dd_v === 'number' ? t.dd_v : null }); }
        return { data: data, initial_capital: cap };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (!r || r.error) return { success: true, data_points: 0, source: 'internal_api', data: [], error: r?.error ?? 'no result' };
  return { success: true, data_points: r.data.length, source: 'internal_api', data: r.data, initial_capital: r.initial_capital, note: 'closed-trade equity: initial capital + cumulative P&L at each exit (TradingView exposes no bar-by-bar curve)' };
}

export async function getQuote({ symbol } = {}) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = ${jsStr(symbol)};
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

// Pure and self-contained: this function is injected into the page via
// .toString(), so it must not reference anything from module scope.
// Reads chart.model().model().dataSources() — the per-study PlotList that
// backs the data window. TradingView Desktop 3.1.0 stubs exportData()
// ("Data export is not supported"), so the model is the only history source.
//   sources     – dataSources() array (studies expose metaInfo() + data())
//   studyFilter – case-insensitive substring of the study description
//   plotFilter  – case-insensitive substring(s) of the plot title; '|' separates alternatives
//   limit       – bars from the end
// PlotList indices are bar indices shared across studies; firstIndex() is a
// huge negative sentinel and valueAt() is null off-range, so always walk back
// from lastIndex() — never from 0.
export function studySeriesFromModel(sources, studyFilter, plotFilter, limit) {
  var sf = String(studyFilter || '').toLowerCase();
  var pfs = String(plotFilter || '').toLowerCase().split('|').filter(function(x) { return x.length > 0; });
  var keep = [];
  var totalColumns = 1;
  var lastIndex = null;
  for (var si = 0; si < sources.length; si++) {
    var s = sources[si];
    if (!s || typeof s.metaInfo !== 'function') continue;
    var mi = s.metaInfo() || {};
    var name = mi.description || mi.shortDescription || '';
    if (!name) continue;
    // Match the filter against both titles ("PF 3G" only appears in shortDescription);
    // columns are always prefixed with the long description.
    var hay = (String(mi.description || '') + '\n' + String(mi.shortDescription || '')).toLowerCase();
    if (sf && hay.indexOf(sf) === -1) continue;
    var d = typeof s.data === 'function' ? s.data() : null;
    if (!d) continue;
    var plots = mi.plots || [];
    totalColumns += plots.length;
    var li = d.lastIndex();
    if (lastIndex === null || li > lastIndex) lastIndex = li;
    for (var pi = 0; pi < plots.length; pi++) {
      var id = plots[pi].id;
      var title = (mi.styles && mi.styles[id] && mi.styles[id].title) || id;
      var lt = title.toLowerCase();
      var ok = pfs.length === 0;
      for (var fi = 0; fi < pfs.length && !ok; fi++) ok = lt.indexOf(pfs[fi]) !== -1;
      if (!ok) continue;
      keep.push({ title: name + '::' + title, data: d, index: pi + 1 });
    }
  }
  var columns = ['time'];
  for (var k = 0; k < keep.length; k++) columns.push(keep[k].title);
  var rows = [];
  var totalRows = 0;
  if (lastIndex !== null) {
    var firstIndex = 0;
    for (var k2 = 0; k2 < keep.length; k2++) firstIndex = Math.max(firstIndex, keep[k2].data.firstIndex());
    totalRows = lastIndex - firstIndex + 1;
    for (var i = Math.max(firstIndex, lastIndex - limit + 1); i <= lastIndex; i++) {
      var row = null;
      for (var c = 0; c < keep.length; c++) {
        var v = keep[c].data.valueAt(i);
        if (!v || v[0] == null) { if (row) row.push(null); continue; }
        if (!row) row = [v[0]];
        row.push(v[keep[c].index]);
      }
      if (row) rows.push(row);
    }
  }
  return { columns: columns, rows: rows, total_columns: totalColumns, total_rows: totalRows };
}

export async function getStudySeries({ study_filter, plot_filter, count } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  const raw = await evaluate(`(${studySeriesFromModel.toString()})(
    ${CHART_API}._chartWidget.model().model().dataSources(),
    ${jsStr(study_filter)}, ${jsStr(plot_filter)}, ${limit})`);
  if (!raw || !raw.columns || raw.columns.length <= 1) {
    throw new Error('No study columns matched. Check study_filter/plot_filter (case-insensitive substrings; "|" separates plot alternatives) and that the study is on the chart. Total columns available: ' + (raw ? raw.total_columns : 0));
  }
  return { success: true, bar_count: raw.rows.length, columns: raw.columns, rows: raw.rows, total_columns: raw.total_columns, total_rows: raw.total_rows };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
