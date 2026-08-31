# Phase 4 — Optimize tab, What-if panel, multi-symbol compare

**Status: 📋 planned** (from the approved v2 master plan; not yet started)
Depends on Phase 3 (reuses its run function per parameter combination).

## 4a. Parameter sweep (Optimize tab, per the recovered artboard)

- Configure 1–2 inputs with value lists (artboard example: Trend Gate Mode {Soft, Hard} ×
  ER threshold 0.20→0.35 step 0.05 = 8 runs, "est ~6 min")
- Loop Phase 3's run serially with pacing (the `delay_ms` pattern from `src/core/batch.js`);
  progress row + cancel; **read original inputs first and restore on finish/cancel** —
  a mid-sweep CDP hiccup must not leave the live chart silently mutated
- Results: all-runs table (net %, PF, max DD, trades, Δ vs baseline) · **sweep matrix**
  (colored div grid, worse→better) · equity-vs-baseline overlay on one canvas
  (baseline dashed grey; categorical colors from the canvas annotation:
  `#3987e5 #d95926 #199e70`)
- `Apply to chart` (sets the winning inputs) · `Save as report` (`type:'sweep'`)
- Edu note ships the artboard's own caveat: *"8 runs · one window · one symbol — a direction,
  not a result"* + overfitting glossary entry (already seeded)

## 4b. What-if panel (Audit tab, right of Blockers — designed in Main.dc.html, never built)

Pure client-side, zero re-runs: the pass mask already encodes every gate per bar, so
"treat gate X as pass" is re-filtering `data.verdicts` (`failedGates`/`sideFailedGates`)
and showing which bars flip FIRED↔BLOCKED. The ±% outcome column joins forward returns
from `data_get_ohlcv` (also enables the artboard's +60m column on Pattern bars).

## 4c. Multi-symbol compare (the user's SOLUSD vs ETHUSD example)

`pane_set_layout {layout:'2h'}` → `pane_set_symbol {index,symbol}` ×2 → per pane:
`pane_focus {index}` → `strategy_gate_audit` → render two summary columns side-by-side.

**Verified already:** every data reader follows the *active* chart
(`src/core/data.js` — `_activeChartWidgetWV`), so focus-then-read gives true per-pane data,
sequentially.

**Unverified blocker:** whether `chart_manage_indicator` adds a study to the focused pane or
pane 0. Until confirmed, the preset requires the strategy to already be on both panes and
says so.

## Risks

- Sweeps are minutes-long UI automation against a live chart — the fragile end of the plan.
  Serialized, paced, cancellable, inputs restored; no auto-retry.
- Sweep results invite overfitting; the UI copy deliberately undersells the winner.
