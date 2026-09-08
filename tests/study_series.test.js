/**
 * Unit tests for data_get_study_series and the injected-JS hardening fixes.
 * No live TradingView needed: these pin the generated-code contracts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jsStr, studySeriesFromModel } from '../src/core/data.js';
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

test('strategy readers share one locate idiom: activeStrategySource, then metaInfo().isTVScriptStrategy', () => {
  assert.ok(!coreSource.includes('is_price_study === false'), 'overlay=true strategies must be detectable');
  // Desktop 3.4 gives EVERY study a `performance` watched value; the old presence scan picked the Volume indicator.
  assert.equal((coreSource.match(/s\.metaInfo && \(s\.ordersData \|\| s\.reportData \|\| s\.performance\)/g) || []).length, 0, 'presence-based scan is gone');
  assert.equal((coreSource.match(/\$\{strategySourceJS\(\)\}/g) || []).length, 3, 'all three strategy readers use strategySourceJS');
  assert.match(coreSource, /activeStrategySource/); assert.match(coreSource, /isTVScriptStrategy/);
});

test('trades keep nested entry/exit scalars via one-level flatten', () => {
  assert.ok(coreSource.includes("tr[ks[q] + '_' + nk[n]] = nv"), 'nested objects flatten to key_subkey scalars (REPORT_FLATTEN_JS)');
  assert.equal((coreSource.match(/\$\{REPORT_FLATTEN_JS\}/g) || []).length, 3, 'all three readers flatten through the shared function');
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

test('getStudySeries reads the chart model PlotList, not exportData (stubbed on Desktop)', () => {
  assert.ok(!coreSource.includes('exportData({ includeTime: true, includeSeries: false, includeStudies: true })'), 'exportData is a hard stub in TradingView Desktop 3.1.0 and must not be used');
  assert.ok(coreSource.includes('Math.min(count || 100, MAX_OHLCV_BARS)'));
  assert.ok(coreSource.includes('studySeriesFromModel.toString()'), 'pure in-page function is injected by source');
});

// Fake of chart.model().model().dataSources() — indices mirror the real PlotList
// (firstIndex is hugely negative, lastIndex is the last bar, valueAt() is null off-range).
function fakeSource(description, plotTitles, bars, shortDescription = description) {
  const plots = plotTitles.map((_, i) => ({ id: 'plot_' + i }));
  const styles = {};
  plotTitles.forEach((t, i) => { if (t) styles['plot_' + i] = { title: t }; });
  const lastIndex = bars.length - 1;
  return {
    metaInfo: () => ({ description, shortDescription, plots, styles }),
    data: () => ({
      firstIndex: () => -1000100,
      lastIndex: () => lastIndex,
      valueAt: (i) => (i < 0 || i > lastIndex) ? null : bars[i],
    }),
  };
}

const PF = fakeSource('PineForge 3rd Gen Volume Profile [Coinbase]', ['Integrated Supertrend', null, 'Audit Final Entry Pass Mask', 'Audit Efficiency Ratio'], [
  [1000, 95.1, 0, 65535, 0.5],
  [1015, 95.2, 0, 65021, 0.7],
  [1030, 95.3, 0, 62815, 0.79],
], 'PF 3G VP');
const VOL = fakeSource('Volume', ['Volume', 'Volume MA'], [[1000, 10, 9], [1015, 11, 9], [1030, 12, 9]]);
const NO_META = { data: () => null };

test('studySeriesFromModel names columns study::plot, falling back to the plot id when a style has no title', () => {
  const r = studySeriesFromModel([NO_META, VOL, PF], 'pineforge', '', 100);
  assert.deepEqual(r.columns, [
    'time',
    'PineForge 3rd Gen Volume Profile [Coinbase]::Integrated Supertrend',
    'PineForge 3rd Gen Volume Profile [Coinbase]::plot_1',
    'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Final Entry Pass Mask',
    'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Efficiency Ratio',
  ]);
  assert.equal(r.total_columns, 5);
});

test('studySeriesFromModel filters plots by case-insensitive substring and keeps time first', () => {
  const r = studySeriesFromModel([VOL, PF], 'PF', 'audit', 100);
  assert.deepEqual(r.columns, [
    'time',
    'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Final Entry Pass Mask',
    'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Efficiency Ratio',
  ]);
  assert.deepEqual(r.rows, [[1000, 65535, 0.5], [1015, 65021, 0.7], [1030, 62815, 0.79]]);
});

test('studySeriesFromModel returns only the last `limit` bars using lastIndex, not index 0', () => {
  const r = studySeriesFromModel([PF], 'PF', 'mask', 2);
  assert.deepEqual(r.rows, [[1015, 65021], [1030, 62815]]);
  assert.equal(r.total_rows, 3);
});

test('studySeriesFromModel merges several studies on the shared time axis', () => {
  const r = studySeriesFromModel([VOL, PF], '', 'volume ma|mask', 100);
  assert.deepEqual(r.columns, ['time', 'Volume::Volume MA', 'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Final Entry Pass Mask']);
  assert.deepEqual(r.rows, [[1000, 9, 65535], [1015, 9, 65021], [1030, 9, 62815]]);
});

test('studySeriesFromModel skips null bars inside the window', () => {
  const gappy = fakeSource('Gap', ['x'], [[1000, 1], null, [1030, 3]]);
  const r = studySeriesFromModel([gappy], 'gap', '', 100);
  assert.deepEqual(r.rows, [[1000, 1], [1030, 3]]);
});

test('studySeriesFromModel matches study_filter against shortDescription too, but prefixes columns with description', () => {
  const r = studySeriesFromModel([VOL, PF], 'pf 3g', 'mask', 100);
  assert.deepEqual(r.columns, ['time', 'PineForge 3rd Gen Volume Profile [Coinbase]::Audit Final Entry Pass Mask']);
  const byDesc = studySeriesFromModel([VOL, PF], 'volume', 'volume ma|mask', 100);
  assert.equal(byDesc.columns.length, 3, 'description match still works for both studies');
});
