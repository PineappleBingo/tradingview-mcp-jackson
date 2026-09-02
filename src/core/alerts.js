/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], '${price}');
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], '${price}');
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

// Pure — no network, so it is unit-testable. Turns the raw REST rows into the question the
// user actually asks of an alert list: which of these are dead, stale, or about to lapse?
//
// stale_version matters more than it looks: a TradingView alert runs the script version it was
// CREATED with, so an alert made before you edited the indicator keeps executing the old logic
// forever. Nothing in TradingView's own UI tells you this.
const SOON_MS = 7 * 24 * 60 * 60 * 1000;
export function annotate(alerts, { now = Date.now(), chartVersions = {} } = {}) {
  return (alerts || []).map((a) => {
    const study = ((a.condition && a.condition.series) || []).find((x) => x && x.type === 'study') || {};
    const exp = a.expiration ? Date.parse(a.expiration) : NaN;
    const live = study.pine_id ? chartVersions[study.pine_id] : undefined;
    const flags = [];
    if (!a.active) flags.push('inactive');
    if (Number.isFinite(exp)) {
      if (exp < now) flags.push('expired');
      else if (exp - now < SOON_MS) flags.push('expiring_soon');
    }
    if (!a.last_fired) flags.push('never_fired');
    if (live && study.pine_version && parseFloat(study.pine_version) < parseFloat(live)) flags.push('stale_version');
    return {
      alert_id: a.alert_id, symbol: a.symbol, type: a.type, resolution: a.resolution,
      active: a.active, message: (a.message || '').slice(0, 120),
      created: a.created, expiration: a.expiration, last_fired: a.last_fired,
      condition_type: a.condition && a.condition.type,
      ...(study.pine_id ? { pine_id: study.pine_id, pine_version: study.pine_version } : {}),
      ...(live ? { chart_version: live } : {}),
      flags,
      health: flags.includes('expired') ? 'dead'
        : (flags.some((f) => f === 'stale_version' || f === 'expiring_soon' || f === 'inactive') ? 'warn' : 'ok'),
    };
  });
}

// pine_id → the version currently loaded on the chart, so annotate() can spot a stale alert.
// Same dataSources()/metaInfo() walk as src/core/data.js.
async function chartScriptVersions() {
  try {
    return await evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          var out = {};
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s.metaInfo) continue;
            try {
              var mi = s.metaInfo() || {};
              // scriptIdPart is exactly the alert's pine_id ("USER;<hash>"); the script's own
              // version lives on mi.pine.version. NOT mi.version — that is the metainfo
              // schema version (101), which would compare as newer than every alert.
              var pid = mi.scriptIdPart;
              var ver = mi.pine && mi.pine.version;
              if (pid && ver) out[pid] = String(ver);
            } catch (e) {}
          }
          return out;
        } catch (e) { return {}; }
      })()
    `) || {};
  } catch { return {}; }
}

// summary defaults ON. The raw rows embed ~200 Pine inputs per alert — 4 alerts came to roughly
// 15k tokens, which is a context hazard for any agent that calls this. Summary is ~200 bytes each.
export async function list({ summary = true } = {}) {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  const raw = result?.alerts || [];
  if (!summary) {
    return { success: true, alert_count: raw.length, source: 'internal_api', alerts: raw, error: result?.error };
  }
  const alerts = annotate(raw, { chartVersions: await chartScriptVersions() });
  const tally = (f) => alerts.filter((a) => a.flags.includes(f)).length;
  return {
    success: true, alert_count: alerts.length, source: 'internal_api',
    summary: {
      active: alerts.filter((a) => a.active).length,
      expired: tally('expired'), expiring_soon: tally('expiring_soon'),
      stale_version: tally('stale_version'), never_fired: tally('never_fired'),
    },
    alerts, error: result?.error,
  };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
