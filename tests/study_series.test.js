/**
 * Unit tests for data_get_study_series and the injected-JS hardening fixes.
 * No live TradingView needed: these pin the generated-code contracts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jsStr } from '../src/core/data.js';
import { registerDataTools } from '../src/tools/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreSource = readFileSync(path.join(__dirname, '..', 'src', 'core', 'data.js'), 'utf8');

test('jsStr JSON-escapes quotes, backslashes, and newlines', () => {
  assert.equal(jsStr('PF 3G'), '"PF 3G"');
  assert.equal(jsStr("a'b"), '"a\'b"');
  assert.equal(jsStr('a"b\\c\nd'), JSON.stringify('a"b\\c\nd'));
  assert.equal(jsStr(undefined), '""');
  assert.equal(jsStr(null), '""');
});

test('graphics filter is escaped and case-insensitive', () => {
  assert.ok(!coreSource.includes("var filter = '${filter}'"), 'raw filter interpolation must be gone');
  assert.ok(coreSource.includes('${jsStr(filter)}.toLowerCase()'), 'filter goes through jsStr + toLowerCase');
  assert.ok(coreSource.includes('name.toLowerCase().indexOf(filter)'), 'study name compared case-insensitively');
});

test('strategy detection no longer requires is_price_study === false', () => {
  assert.ok(!coreSource.includes('is_price_study === false'), 'overlay=true strategies must be detectable');
  const matches = coreSource.match(/s\.metaInfo && \(s\.ordersData \|\| s\.reportData \|\| s\.performance\)/g) || [];
  assert.equal(matches.length, 3, 'all three strategy readers use presence-based detection');
});

test('trades keep nested entry/exit scalars via one-level flatten', () => {
  assert.ok(coreSource.includes("trade[okeys[k] + '_' + nkeys[n]] = nv"), 'nested objects flatten to key_subkey scalars');
  assert.ok(coreSource.includes('const MAX_TRADES = 200'), 'trade ceiling raised (request default stays 20)');
});

test('data_get_study_series is registered with expected params', () => {
  const tools = new Map();
  const stub = { tool: (name, desc, schema) => tools.set(name, { desc, schema }) };
  registerDataTools(stub);
  assert.ok(tools.has('data_get_study_series'), 'new tool registered');
  const { schema, desc } = tools.get('data_get_study_series');
  assert.deepEqual(Object.keys(schema).sort(), ['count', 'plot_filter', 'study_filter']);
  assert.match(desc, /per-bar/i);
  assert.ok(tools.has('data_get_study_values'), 'existing tools still registered');
});

test('getStudySeries clamps count and exports study columns in-page', () => {
  assert.ok(coreSource.includes('exportData({ includeTime: true, includeSeries: false, includeStudies: true })'));
  assert.ok(coreSource.includes('Math.min(count || 100, MAX_OHLCV_BARS)'));
  assert.ok(coreSource.includes("keep.push({ index: i, title: sourceTitle + '::' + plotTitle })"), 'columns filtered before crossing CDP');
});
