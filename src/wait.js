import { evaluate } from './connection.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Try to get bar count from data window or chart
        var barCount = -1;
        try {
          var bars = document.querySelectorAll('[class*="bar"]');
          barCount = bars.length;
        } catch {}

        // Get current symbol from header
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}

// ── Strategy Tester settle detection (Phase 3) ──────────────────────────────
// indicator_set_inputs returns the instant setInputValues() is called; the tester then
// repopulates in stages (orders first, report last). Nothing in TradingView announces
// "done", so we watch a cheap signature and call it settled once it has CHANGED from the
// pre-change value and then stayed identical for `stablePolls` consecutive polls.
export const TESTER_SIGNATURE_JS = `
  (function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var strat = null;
      for (var i = 0; i < sources.length; i++) { var s = sources[i]; if (s.metaInfo && (s.ordersData || s.reportData || s.performance)) { strat = s; break; } }
      if (!strat) return { found: false };
      var unwrap = function(v) { if (v && typeof v === 'object' && typeof v.value === 'function') v = v.value(); return v; };
      var pick = function(o, keys) { if (!o) return null; for (var k = 0; k < keys.length; k++) { var v = o[keys[k]]; if (v === undefined || v === null) continue; if (typeof v === 'object' && v.all !== undefined) v = v.all; if (typeof v === 'number') return v; } return null; };
      var orders = null;
      try { orders = unwrap(typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData); } catch (e) {}
      if (!Array.isArray(orders)) { try { orders = unwrap(typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData); } catch (e) {} }
      var tradeCount = Array.isArray(orders) ? orders.length : null;
      var lastKey = null;
      if (Array.isArray(orders) && orders.length) {
        var last = orders[orders.length - 1], parts = [];
        var walk = function(o, depth) { if (!o || typeof o !== 'object' || depth > 1) return; var ks = Object.keys(o); for (var k = 0; k < ks.length; k++) { var v = o[ks[k]]; if (typeof v === 'number' || typeof v === 'string') parts.push(ks[k] + '=' + v); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, depth + 1); } };
        walk(last, 0); lastKey = parts.join('|').slice(0, 400);
      }
      var rd = null;
      try { rd = unwrap(typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData); } catch (e) {}
      return { found: true, tradeCount: tradeCount, lastKey: lastKey,
        netProfit: pick(rd, ['netProfit', 'net_profit']), totalTrades: pick(rd, ['totalTrades', 'total_trades']) };
    } catch (e) { return { found: false, error: e.message }; }
  })()
`;

export async function testerSignature() {
  return evaluate(TESTER_SIGNATURE_JS);
}

export const sigKey = (s) => JSON.stringify(s && s.found ? [s.tradeCount, s.lastKey, s.netProfit, s.totalTrades] : null);

/**
 * Poll until the tester signature has changed from `before` and then stayed identical for
 * `stablePolls` polls. Never throws on timeout: returns { settled:false } and lets the caller
 * flag the run as 'unsettled'. `signature` / `sleep` / `now` are injectable for tests.
 */
export async function waitForTesterSettle({ before, pollMs = 250, stablePolls = 3, timeoutMs = 15000, signature = testerSignature, sleep: sleepFn = sleep, now = Date.now } = {}) {
  const limit = Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));
  const start = now();
  const beforeKey = sigKey(before);
  let changed = false, stable = 0, prevKey = null, last = before, polls = 0;
  while (now() - start < limit) {
    await sleepFn(pollMs);
    polls++;
    let sig = null;
    try { sig = await signature(); } catch { sig = null; }
    const key = sigKey(sig);
    if (sig && sig.found && key !== beforeKey) changed = true;
    if (changed) stable = key === prevKey ? stable + 1 : 1;
    prevKey = key; last = sig;
    if (changed && stable >= stablePolls) return { settled: true, settleMs: now() - start, polls, signature: last };
  }
  return { settled: false, settleMs: now() - start, polls, changed, signature: last };
}
