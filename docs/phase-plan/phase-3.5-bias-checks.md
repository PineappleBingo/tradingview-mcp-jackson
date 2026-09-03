# Phase 3.5 — Bias checks: repaint / lookahead and history sensitivity

**Status: 📋 planned · optional** — added in the 2026-09-03 redesign. Verify live before
building; nothing in Phase 4 depends on it.

## Why

freqtrade ships two analyses that answer "is this backtest lying to me?" before anyone
optimizes anything: **lookahead-analysis** (does a signal change when the future is cut
off?) and **recursive-analysis** (do indicator values change with the amount of leading
history?). Pine has both failure modes — `request.security()` without
`lookahead=barmerge.lookahead_off`, `calc_on_every_tick`, drawings updated on later bars,
`ta.*` warm-up depending on how many bars TradingView happened to load — and PF 3G VP is
explicitly "non-lookahead" by design, which is a claim worth checking with data. Neither
freqtrade module ports as-is: they diff pandas indicator frames we cannot reach. Both port
as **reduced, trade-list-level** checks using tools the server already has.

## Check A — repaint / lookahead via Bar Replay (`strategy_repaint_check {date}`)

Bar Replay recomputes the strategy with data only up to the replay point, so trades that
exist in the full-history run but not in the truncated run (or that moved) are evidence of
lookahead or repainting.

1. `readStrategySnapshot()` on the full run → `full = trades with exitTime ≤ D` (Phase 3 helper).
2. `replay.start({date: D})` (`src/core/replay.js:10`) → wait with `waitForTesterSettle`
   → `readStrategySnapshot()` → `cut = trades`.
3. `replay.stop()` in `finally` (`src/core/replay.js:66`).
4. Diff by `(entryTime, side)`: `missing` (in `full`, not in `cut`), `extra` (in `cut` only),
   `moved` (same entry time, different exit or price beyond one tick).
5. `verdict = 'clean'` when all three lists are empty; `'repaints'` otherwise, with the
   first 20 mismatches listed.

Analog of freqtrade `freqtrade/optimize/analysis/lookahead.py` (`false_entry_signals` /
`false_exit_signals`), reduced from "recompute indicators over a truncated frame" to
"recompute the strategy over a truncated chart". Inherits the same honesty note: a signal
that never fired cannot be verified (false negatives are possible).

## Check B — history sensitivity (`strategy_history_check`)

1. Snapshot metrics and the last 50 trades.
2. Force more history: `chart_scroll_to_date` far enough back to load additional bars
   (TradingView appends history on scroll), then `waitForChartReady` and
   `waitForTesterSettle`.
3. Snapshot again; compare trades that fall inside the **originally loaded** window.
4. Any change in entries/exits/P&L inside that window → `verdict:'history-sensitive'` with
   the drift per metric (`(after − before)/before`).

Analog of freqtrade `freqtrade/optimize/analysis/recursive.py` (startup-candle sweep
`[199,399,499,999,1999]` compared on the last candle); here the "startup candles" are
whatever TradingView loaded first versus loaded-more.

## Contract

```
BiasReport { kind:'repaint'|'history', date?, before:{tradeCount, netProfit}, after:{…},
             mismatches:[{type:'missing'|'extra'|'moved', entryTime, side, detail}],
             verdict:'clean'|'repaints'|'history-sensitive'|'inconclusive', notes:string[] }
```

Saved through `POST /reports` as `type:'backtest'` with `title: 'bias check · <kind>'` so it
lands next to the run it audits.

## Placement

- New functions in `src/core/backtest.js` (share the snapshot/settle helpers); two tools in
  `src/tools/backtest.js`; one prompt-bar preset `bias check` (`kind:'js'`) on the Backtest tab.
- **Not** part of the sweep path: replay is UI automation and adds minutes; run it once per
  strategy version, not per parameter set.

## Risks

- Replay availability differs by symbol/plan (`isReplayAvailable()` guard at `src/core/replay.js:12`).
- Scroll-to-load is nondeterministic; Check B reports `inconclusive` when the bar count did
  not grow.
- Both checks mutate chart state (replay mode, visible range) — always restore in `finally`.
