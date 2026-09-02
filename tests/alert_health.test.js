import test from 'node:test';
import assert from 'node:assert/strict';
import { annotate } from '../src/core/alerts.js';

// Shapes taken from a real GET /list_alerts response on this account, trimmed to the fields
// annotate() reads. NOW sits between the two expiration dates below on purpose.
const NOW = Date.parse('2026-09-02T13:00:00Z');

const indicatorAlert = (over = {}) => ({
  alert_id: 1, symbol: 'COINBASE:SOLUSD', type: 'indicator', resolution: '5',
  message: 'Confirmed persistent-POC support absorption', active: true,
  created: '2026-08-12T20:22:25Z', expiration: '2026-09-12T20:21:44Z', last_fired: null,
  condition: { type: 'alert_cond', series: [{ type: 'study', pine_id: 'USER;pf3g', pine_version: '21.0', inputs: {} }] },
  ...over,
});

test('annotate flags an alert pinned to an older script version than the chart', () => {
  const [a] = annotate([indicatorAlert()], { now: NOW, chartVersions: { 'USER;pf3g': '28.0' } });
  assert.ok(a.flags.includes('stale_version'), 'v21 alert vs v28 on chart is stale: ' + a.flags);
  assert.equal(a.pine_version, '21.0');
  assert.equal(a.chart_version, '28.0');
  assert.equal(a.health, 'warn');
});

test('annotate does not flag an alert matching the chart version', () => {
  const [a] = annotate([indicatorAlert({ pine: 1 })], { now: NOW, chartVersions: { 'USER;pf3g': '21.0' } });
  assert.ok(!a.flags.includes('stale_version'), 'same version is not stale');
});

test('annotate leaves stale_version off when the study is not on the chart at all', () => {
  // No chart version to compare against — silence beats a guess.
  const [a] = annotate([indicatorAlert()], { now: NOW, chartVersions: {} });
  assert.ok(!a.flags.includes('stale_version'));
  assert.equal(a.chart_version, undefined);
});

test('annotate separates expired from expiring_soon, and never both', () => {
  const rows = annotate([
    indicatorAlert({ alert_id: 2, expiration: '2026-08-23T21:40:37Z', active: false }), // 10 days past
    indicatorAlert({ alert_id: 3, expiration: '2026-09-05T00:00:00Z' }),                // 3 days out
    indicatorAlert({ alert_id: 4, expiration: '2026-12-01T00:00:00Z' }),                // far off
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.flags.includes('expired')), [true, false, false]);
  assert.deepEqual(rows.map((r) => r.flags.includes('expiring_soon')), [false, true, false]);
  assert.equal(rows[0].health, 'dead');
  assert.equal(rows[2].health, 'ok', 'a healthy alert that never fired is still ok: ' + rows[2].flags);
});

test('annotate strips the Pine input blob that makes the raw response enormous', () => {
  const fat = indicatorAlert();
  for (let i = 0; i < 200; i++) fat.condition.series[0].inputs['in_' + i] = 'x'.repeat(20);
  const raw = JSON.stringify([fat]).length;
  const small = JSON.stringify(annotate([fat], { now: NOW })).length;
  assert.ok(small < raw / 5, `summary ${small}B must be far under raw ${raw}B`);
  assert.ok(!JSON.stringify(annotate([fat], { now: NOW })).includes('in_199'), 'inputs are gone');
});

test('annotate tolerates rows with no study series or no expiration', () => {
  const [a] = annotate([{ alert_id: 9, symbol: 'X', active: true, condition: { type: 'cross', series: [{ type: 'value', value: 0 }] } }], { now: NOW });
  assert.equal(a.pine_id, undefined);
  assert.ok(!a.flags.includes('expired'), 'a missing expiration is not an expired alert');
  assert.equal(a.health, 'ok');
});

test('annotate compares versions numerically, not as strings', () => {
  // "9.0" > "69.0" lexically, so a string compare would call a v9 alert current against a
  // v69 chart. Real data hit exactly this shape: alerts at v9/v21/v28 against a v69 script.
  const rows = annotate([
    indicatorAlert({ alert_id: 1, condition: { type: 'alert_cond', series: [{ type: 'study', pine_id: 'p', pine_version: '9.0' }] } }),
    indicatorAlert({ alert_id: 2, condition: { type: 'alert_cond', series: [{ type: 'study', pine_id: 'p', pine_version: '69.0' }] } }),
  ], { now: NOW, chartVersions: { p: '69.0' } });
  assert.equal(rows[0].flags.includes('stale_version'), true, 'v9 is behind v69');
  assert.equal(rows[1].flags.includes('stale_version'), false, 'v69 matches v69');
});
