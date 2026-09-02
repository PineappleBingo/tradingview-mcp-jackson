import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list',
    'List alerts with health flags (expired, expiring_soon, stale_version, never_fired, inactive). '
    + 'Summarised by default — pass summary:false only if you need the raw Pine inputs, which are ~200 per alert.', {
    summary: z.coerce.boolean().optional().describe('Default true. false returns raw rows (very large).'),
  }, async ({ summary }) => {
    try { return jsonResult(await core.list({ summary: summary !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_toggle', 'Turn an alert on or off (TradingView stop_alerts/restart_alerts). Reversible.', {
    alert_id: z.union([z.coerce.number(), z.array(z.coerce.number())]).describe('Alert id, or an array of ids (from alert_list)'),
    on: z.coerce.boolean().describe('true = active, false = paused'),
  }, async ({ alert_id, on }) => {
    try { return jsonResult(await core.toggle({ alert_id, on })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
