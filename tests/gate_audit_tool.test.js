/**
 * strategy_gate_audit tool registration + runGateAudit composition (fake deps, no CDP).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerGateAuditTools } from '../src/tools/gateAudit.js';
import { runGateAudit, loadProfile } from '../src/core/gateAudit.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = 'PineForge 3rd Gen Volume Profile [Coinbase]::';
const SERIES = {
  columns: ['time', P + 'Audit Final Entry Pass Mask', P + 'Audit Long Execution Reason', P + 'Final Entry Trigger Long'],
  rows: [[1787716800, 65021, 8, 0], [1787717700, 65535, 2, 1]],
  bar_count: 2,
};

test('strategy_gate_audit is registered with expected params and description', () => {
  const tools = new Map();
  registerGateAuditTools({ tool: (name, desc, schema) => tools.set(name, { desc, schema }) });
  assert.ok(tools.has('strategy_gate_audit'));
  const { schema, desc } = tools.get('strategy_gate_audit');
  assert.deepEqual(Object.keys(schema).sort(), ['count', 'profile', 'study_filter']);
  assert.match(desc, /blocker|gate/i);
});

test('server registers the tool and core index exports the module', () => {
  assert.ok(readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8').includes('registerGateAuditTools(server)'));
  assert.ok(readFileSync(path.join(ROOT, 'src', 'core', 'index.js'), 'utf8').includes('gateAudit'));
});

test('runGateAudit composes study, chart, bar_count and decoded verdicts using profile defaults', async () => {
  const calls = [];
  const out = await runGateAudit({}, {
    getStudySeries: async (args) => { calls.push(args); return SERIES; },
    getChartState: async () => ({ success: true, symbol: 'COINBASE:SOLUSD', resolution: '15' }),
  });
  assert.equal(out.success, true);
  assert.equal(out.study, 'PineForge 3rd Gen Volume Profile [Coinbase]');
  assert.deepEqual(out.chart, { symbol: 'COINBASE:SOLUSD', resolution: '15' });
  assert.equal(out.bar_count, 2);
  assert.equal(out.summary.fired, 1);
  assert.equal(out.summary.blocked, 1);
  assert.equal(out.verdicts[0].blocker, 'RoomL');
  assert.equal(out.profile.gates.length, 16);
  assert.equal(calls[0].study_filter, loadProfile().studyFilter);
  assert.ok(calls[0].plot_filter.includes('|'));
  assert.equal(calls[0].count, 200);
});

test('runGateAudit passes overrides through and tolerates a failing chart_get_state', async () => {
  let seen;
  const out = await runGateAudit({ study_filter: 'Other', count: 50 }, {
    getStudySeries: async (args) => { seen = args; return SERIES; },
    getChartState: async () => { throw new Error('CDP down'); },
  });
  assert.equal(seen.study_filter, 'Other');
  assert.equal(seen.count, 50);
  assert.equal(out.chart, null);
  assert.equal(out.success, true);
});
