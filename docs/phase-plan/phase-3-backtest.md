# Phase 3 — Backtest tab

**Status: 📋 planned** (from the approved v2 master plan; not yet started)

## Principle

Read the **live TradingView Strategy Tester** — no simulator is written. The canvas
annotation on the recovered `Backtest.dc.html` artboard says exactly this.

## Design (from the artboard: Configure → Run → Results → Save)

### Configure card
- symbol, timeframe, optional input overrides as free-form key/value pairs
- overrides apply via `indicator_set_inputs {entity_id, inputs}`; the entity id comes from
  `chart_get_state`
- **date range ships display-only.** True range control needs TradingView "deep backtesting"
  UI automation (`ui_click` on the tester panel) — deferred with a `ponytail:` ceiling note.

### Run = a sequence over the existing `call()` helper
`chart_set_symbol` → `chart_set_timeframe` → optional `indicator_set_inputs` → wait/poll →
`data_get_strategy_results` + `data_get_trades {max_trades:200}` + `data_get_equity`

### Results
- equity curve as a polyline on a `<canvas>` (reuse `prep()`; match `drawStrip` styling)
- key-metrics table: net profit, total trades, win rate, profit factor, max drawdown,
  avg trade, long/short split (all fields the artboard shows)
- trades table reusing `drawTable`'s sort pattern
- **Save as report** → `POST /reports` with `type:'backtest'` (store and Reports tab already
  handle arbitrary types)

### Edu content
`.edu-note` per card + glossary terms already seeded in Phase 1 (backtest, profit factor,
max drawdown, win rate).

## Open questions to verify at phase start (not verifiable without the live chart)

1. **Is PF 3G VP protected/encrypted?** CLAUDE.md rule 5: protected indicators return encoded
   input blobs — if so, `indicator_set_inputs` key discovery may fail and overrides degrade
   to "change inputs manually in TradingView, then run".
2. How long after `indicator_set_inputs` until the Strategy Tester repopulates — poll
   `data_get_strategy_results` until stable rather than a fixed sleep.
3. Restore original inputs after a run? (Read first via `data_get_indicator`, restore on
   finish — decide whether that's Phase 3 or only needed for Phase 4 sweeps.)

## Verification sketch

Configure SOLUSD·5 with one override → run → equity/metrics/trades match the Strategy Tester
panel on screen (screenshot comparison) → save → report card shows `type: backtest` →
80/80 unit tests stay green (new size ceiling if needed, raised deliberately).
