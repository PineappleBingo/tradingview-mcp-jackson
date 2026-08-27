/**
 * Chart-target selection: never attach to TradingView Desktop's internal file:// pages
 * (their paths contain "TradingView", which the old fallback regex matched during startup).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickChartTarget } from '../src/connection.js';

const internal = [
  { type: 'page', id: 'a', url: 'file:///opt/TradingView/resources/app.asar/app/browser-api-container/index.html' },
  { type: 'page', id: 'b', url: 'file:///opt/TradingView/resources/app.asar/app/window/index.html?rendererInitialData=%7B' },
  { type: 'worker', id: 'w', url: 'https://www.tradingview.com/chart/worker.js' },
];

test('prefers the tradingview.com/chart page', () => {
  const chart = { type: 'page', id: 'c', url: 'https://www.tradingview.com/chart/3GDxnHHr/' };
  assert.equal(pickChartTarget([...internal, chart]).id, 'c');
});

test('falls back to any tradingview.com page but never to file:// app pages', () => {
  const other = { type: 'page', id: 'o', url: 'https://www.tradingview.com/screener/' };
  assert.equal(pickChartTarget([...internal, other]).id, 'o');
  assert.equal(pickChartTarget(internal), null);
});
