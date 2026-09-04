import { evaluate } from './connection.js';
import { strategySourceJS, REPORT_FLATTEN_JS } from './core/data.js';

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
// The signature deliberately ignores the OPEN trade: its exit price/time tick with the live
// quote, so including it would never settle on a chart that holds a position.
export const testerSignatureJS = (entityId = null) => `
  (function() {
    try {
      var strat = ${strategySourceJS(entityId)};
      if (!strat) return { found: false };
      var f = (${REPORT_FLATTEN_JS})(strat, 3);
      var last = null; for (var i = f.trades.length - 1; i >= 0; i--) if (!f.trades[i].open) { last = f.trades[i]; break; }
      var parts = []; if (last) { var ks = Object.keys(last); for (var k = 0; k < ks.length; k++) parts.push(ks[k] + '=' + last[ks[k]]); }
      var pick = function(key) { var v = f.report[key]; return v && typeof v === 'object' ? v.all : (typeof v === 'number' ? v : null); };
      return { found: true, tradeCount: f.tradesTotal - f.openTrades, lastKey: parts.join('|').slice(0, 400), netProfit: pick('netProfit'), totalTrades: pick('totalTrades') };
    } catch (e) { return { found: false, error: e.message }; }
  })()
`;
export const TESTER_SIGNATURE_JS = testerSignatureJS();

export async function testerSignature(entityId = null) {
  return evaluate(entityId ? testerSignatureJS(entityId) : TESTER_SIGNATURE_JS);
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
