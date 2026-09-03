# Phase 4 — Optimize tab: typed parameter space, objective registry, a resumable sweep job, and a verdict

**Status: 🛠 implemented 2026-09-03 · live verification pending** (commits `6fa737f` core · `777521a` sweep job · `389e4ae` viewer · `ff282e0` decision resolution; see [implementation notes](./phase-3-4-implementation-notes.ko.md) for what differs from this spec)
Depends on Phase 3: `runBacktest()`, `RunCard`, `validate.js`, `POST /reports`, `timeoutMs` on `/call`.
Korean companions: [what changed and why](./phase-3-4-redesign-notes.ko.md) · [where each pattern comes from](./functional-spec-sources.ko.md)

## What changed against the first plan

- **Viewer-side serial loop → bridge-side job** with an on-disk journal, cancel, resume and
  guaranteed input restore. A browser tab cannot own a 20-minute chart mutation.
- **"1–2 inputs with value lists" → a typed `ParamSpace`** seeded from the study's own
  `metaInfo` ranges plus a curated shortlist in the profile, with a decimals policy.
- **"all-runs table + matrix" → objective registry + IS/OOS + stability + Monte-Carlo p-value
  + a deterministic verdict + a decision log.** The artboard's caveat ("a direction, not a
  result") becomes a computed statement instead of a sentence.

Everything visual in the recovered `Optimize.dc.html` artboard stays: parameter rows,
`runs N · est ~M min`, equity-vs-baseline overlay, selected-variant gauges with a baseline
tick, all-runs table, sweep matrix, Apply to chart, Save as report.

## 4a.1 Parameter space — `src/core/paramspace.js`

```
ParamSpace { params:[{ id:'in_N', label, type:'int'|'decimal'|'categorical'|'bool',
                       values?:any[], min?, max?, step?, decimals?:number(≤3),
                       source:'metaInfo'|'profile'|'user' }],
             sampler:{ kind:'grid'|'random'|'halving', n?:number, seed?:number,
                       maxEvals:64, earlyStop:{patience:10} },
             objective:string, splitDate?:ISO, topK:3 }
```

Types mirror freqtrade's `IntParameter` / `DecimalParameter` / `CategoricalParameter` /
`BooleanParameter`. Every numeric parameter is **enumerated up front** (`values[]` from
`min..max` by `step`) so the space is finite and printable — freqtrade's `SKDecimal`
argument: an unbounded real axis is how spurious-precision winners appear.

**Seeding.** `seedFromMeta(metaInputs)` reads `min`, `max`, `step`, `options` from
`metaInfo().inputs[]` (the `META_JS` probe at `scripts/viewer/gate-audit.html:506-510` is
extended to emit them). PF 3G VP declares those bounds positionally for 86 numeric inputs
(`third_generation_volume_profile_strategy.pine`: `entryVolumeMult` :142 `0.5–3.0/0.1`,
`entryBodyAtrMult` :143, `strategyStopAtr` :155 `0.25–10/0.25`, `strategyTakeAtr` :156
`0.5–20/0.25`, `opposingPocMinRoomAtr` :166 `0–10/0.05`, `macroBiasRecoveryBars` :175 `1–10`,
`breakoutSettlementBars` :180 `1–2`, `dShapeBoundarySettlementBars` :191 `1–3`, `erLength`
:197 `5–50`, `erRangeThreshold` :198 `0.05–0.60/0.05`, `erReleaseThreshold` :199
`0.10–0.80/0.05`, `rangeRegimeMinBars` :200 `1–10`). String inputs carry `options`; bools
are `[true,false]`. Whether TradingView surfaces the numeric bounds through `metaInfo` is
Phase 3 open question 3; if it does not, the profile shortlist below is the fallback and
`user` overrides fill the rest.

**Profile shortlist.** `profiles/pf3g-vp.json` gains `optimize.shortlist` — the sweep
*window* (narrower than the declared range) for the inputs `governingInputs` already names,
keyed by label and resolved to `in_N` at runtime by joining `metaInfo().inputs[].name`
(the join `settingsText()` performs today, `gate-audit.html:511-543`):

| Label (Pine id) | Window | Type |
|---|---|---|
| Trend Gate Mode (`supertrendMode`) | Soft Filter, Hard Filter | categorical |
| Trend Gate Engine (`trendGateEngine`) | Radius Trend, Supertrend | categorical |
| ER Range Threshold (`erRangeThreshold`) | 0.15 → 0.40 step 0.05 | decimal(2) |
| ER Release (`erReleaseThreshold`) | 0.30 → 0.60 step 0.05 | decimal(2) |
| Efficiency Ratio Length (`erLength`) | 10 → 20 step 2 | int |
| Regime Confirmation Bars (`rangeRegimeMinBars`) | 2 → 5 | int |
| Range Regime Gate (`rangeRegimeMode`) | Warning Only, Hard Filter | categorical |
| Confirmed Profile Macro Bias (`macroProfileBiasMode`) | Soft Filter, Warning Only, Off | categorical |
| Macro Bias Recovery Closes (`macroBiasRecoveryBars`) | 1 → 4 | int |
| Structural POC Proximity Guard (`opposingPocGuardMode`) | Warning Only, Hard Filter | categorical |
| Minimum Structural Room (ATR) (`opposingPocMinRoomAtr`) | 0.50 → 1.25 step 0.25 | decimal(2) |
| Projected Target Policy (`projectedTargetPolicy`) | Hard Filter, Warning Only | categorical |
| D-Shape Filter Mode (`dShapeFilterMode`) | Hard Filter, Warning Only | categorical |
| D-Shape Boundary Settlement Bars (`dShapeBoundarySettlementBars`) | 1 → 3 | int |
| Strategy Stop ATR (`strategyStopAtr`) — exit group | 0.75 → 1.50 step 0.25 | decimal(2) |
| Strategy Take Profit ATR (`strategyTakeAtr`) — exit group | 1.5 → 3.0 step 0.5 | decimal(1) |

Functions: `seedFromMeta(meta)`, `resolveLabels(shortlist, meta)`, `expandGrid(space)`
(cartesian product; throws with the count when > 64), `sampleRandom(space, n, seed)`,
`halvingPlan(space, {n0:16, top:4})`, `neighbors(point, space)` (±1 step per numeric
dimension, adjacent option for categoricals in declared order), `countEvals(space)`.

## 4a.2 Objective registry — `src/core/objectives.js`

Every objective is **smaller-is-better** over a `RunCard`'s normalized metrics (freqtrade's
`hyperopt_loss_function` contract), so samplers, ranking and the matrix never special-case
a direction. `list()` feeds the viewer's selector; `score(name, metrics, validation)` returns
a number or `null` (which ranks last).

| Name | Formula | Origin |
|---|---|---|
| `only_profit` | `−netProfit` | freqtrade `OnlyProfitHyperOptLoss` |
| `profit_factor` | `−min(PF, 10)` | freqtrade docs' SQN/PF guidance |
| `sharpe` | `−sharpe` (trade-based, Phase 3 definition) | freqtrade `SharpeHyperOptLoss` |
| `sortino` | `−sortino` | freqtrade `SortinoHyperOptLoss` |
| `calmar` | `−calmar` | freqtrade `CalmarHyperOptLoss` |
| `max_drawdown_ratio` | `−netProfit / maxDrawdown` (`−netProfit` when DD = 0) | freqtrade `MaxDrawDownHyperOptLoss` |
| `profit_drawdown` | `−(netProfit − relDD·netProfit·(1 − 0.075))`, `relDD = maxDrawdownPct/100` | freqtrade `ProfitDrawDownHyperOptLoss` (`DRAWDOWN_MULT = 0.075`) |
| **`multi_metric`** (default) | `−(profitDraw · ln(PF + 1) · ln(min(10, expectancyRatio) + 2) · ln(1.2 + winRate) · penalty)`, `profitDraw` as above, `penalty = tradeCountPenalty(n, {target:30})` | freqtrade `MultiMetricHyperOptLoss` (target 50 → 30 here) |

**Default = `multi_metric`.** Its trade-count penalty and log-damped profit factor are the
two terms that directly counter the "three lucky trades" winner the artboard warns about;
`profit_drawdown` is the quick alternative when only return-vs-pain matters. Both are
re-implemented from the published formulas (freqtrade is GPLv3 — no code is copied).

## 4a.3 Samplers and budget

| Sampler | Plan | Evaluations |
|---|---|---|
| `grid` | full cartesian product | ≤ 64 (hard cap; the artboard's 2 × 4 = 8 is the typical case) |
| `random` | `n` seeded draws without replacement | default 16 |
| `halving` | 16 random → rank by IS objective → top 4 → each point's `neighbors()` (≤ 8) | ≤ 16 + 32 = 48 |
| early stop | best objective unimproved for **10** consecutive evaluations → stop with `reason:'plateau'` | — |

Budget arithmetic: `maxEvals = 64`; one evaluation = settle (≤ 15 s default, ≤ 45 s worst)
+ 1 000 ms pacing, so the ceiling is ≈ 48 min and a typical 8-run sweep ≈ 2–6 min (the
artboard's "est ~6 min"). `expectedMs = baselineSettleMs × remaining` drives the progress bar.

**Not adopted:** Optuna/TPE, CMA-ES, NSGA-II and joblib parallelism (freqtrade, quants-lab,
FinRL). Three reasons: a Python dependency inside a Node bridge; a 64-evaluation budget where
Bayesian samplers gain little over halving; and quants-lab's Optuna optimizer ships with no
walk-forward or out-of-sample check — the piece we most need is the one it lacks. Plateau
early-stop is kept (freqtrade `--early-stop`, FinRL's `LoggingCallback` idea) because Pine
re-runs are the expensive resource.

## 4a.4 Sweep job — `scripts/sweep-job.js` (imported by `scripts/http-bridge.js`)

```
SweepJob { id, state:'running'|'done'|'error'|'cancelled'|'timeout', startedAt, endedAt?,
           elapsedMs, expectedMs, total, done, current:{index, inputs},
           space:ParamSpace, baseline:RunCardSummary,
           results:[{index, inputs, configHash, metrics:{netProfit,netProfitPct,profitFactor,maxDrawdownPct,totalTrades,winRate},
                     objective, isObjective, oos?:{netProfit,profitFactor}, settled, warnings}],
           restore:{original:{[in_N]:value}, restored:boolean, verified:boolean|null},
           reportId?, error?, reason?:'plateau'|'cap' }
Journal  reports/sweeps/<id>.jsonl — {type:'header', space, baseline, original} · {type:'run', …} per evaluation · {type:'end', state, reason}
Routes   POST /sweep {space, objective?, splitDate?, title?} → {id}     409 while a sweep OR an agent run is active
         GET  /sweep/status                                          same shape as /agent/status + total/done/current
         POST /sweep/cancel                                          sets the cancel flag; restore runs in finally
         POST /sweep/resume {id}                                     re-reads the journal, skips finished indices
         POST /sweep/apply {id, index}                               sets that run's inputs on the chart; writes a 'decision' report (pending)
         /health += { sweep:true }
```

The state object mirrors `agentRun` (`scripts/http-bridge.js:149-160`, incl. `elapsedOf`
freezing at `endedAt`) and reuses its status/cancel/resume conventions so the viewer's
existing polling code is copied, not invented. **One chart-mutating job at a time:** `/agent`
and `/sweep` share a `busy()` check (an agent reading the chart mid-sweep would report a
half-applied parameter set).

Loop:

1. Baseline: `runBacktest({inputs:{}, restore:false, splitDate})` on the current inputs; store
   the header record with the original inputs of every parameter in `space`.
2. Plan: `expandGrid` / `sampleRandom` / `halvingPlan` (halving plans its second stage after
   the first 16 results).
3. For each point: `callTool('strategy_run_backtest', {config:{inputs:point, restore:false, splitDate}}, 120_000)`
   in-process (never through HTTP, so the 30 s default is irrelevant) → append a `run` line →
   1 000 ms pace → check cancel flag → early-stop check.
4. `finally`: restore the original inputs (`setInputs`), then run one more baseline read and
   set `restore.verified = (baselineAfter.configHash === baseline.configHash && tradeCount equal)`.
   If restore throws, `state:'error'` and the viewer shows a red banner listing the original
   inputs so the user can re-apply them by hand — a mid-sweep CDP hiccup must never leave
   the chart silently mutated.
5. `selectAndVerdict()` (4a.5) → `POST`-equivalent write of a `type:'sweep'` report → `reportId`.

Timeout `MCP_BRIDGE_SWEEP_TIMEOUT_MS` (default 3 600 000) → `state:'timeout'`, resumable. A
bridge restart mid-sweep loses only memory: the journal is on disk and `POST /sweep/resume`
continues from the last written index (quants-lab's persistent Optuna study with
`load_if_exists=True`, minus Optuna).

## 4a.5 Selection, verdict, decision log — `src/core/sweep.js` (pure)

1. `rank(results, objective)` — on IS metrics when `splitDate` is set, else on the full window.
2. **OOS check** for the top-3: `oosHolds = oos.profitFactor > 1 && oos.netProfit > 0`.
3. **Stability**: `stability(i) = mean(objective of neighbors(i))` (grid) or of the 3 nearest
   evaluated points (random/halving). The selected run is `argmin over top-3 of
   (objective + stability)/2` — a plateau centre beats an isolated peak (freqtrade's
   "different random states give different winners" warning, made mechanical).
4. **Monte-Carlo p-value** and trade count from the selected run's `validation`.
5. **Verdict** (TradingAgents' judge with an explicit Hold): `insufficient` when the selected
   run has `n < 30`, is unsettled, or fewer than 8 settled runs exist; `edge` when
   `pSharpe < 0.05 ∧ oosHolds ∧ objective better than baseline`; otherwise `noise`.
   `reasons[]` names every rule that fired; the UI prints them next to the badge.
6. Output `selection:{ranked, oos, stability, selectedIndex, verdict, reasons}` into the sweep report.

**Decision log.** `POST /sweep/apply` writes a report `{type:'decision', data:{configHash,
inputs, verdict, status:'pending', sweepReportId}}`. A later `strategy_run_backtest` whose
`configHash` matches a pending decision and whose `window.lastTradeTime` lies beyond the
sweep's window fills `realized:{netProfit, profitFactor}` and flips `status:'resolved'`;
the `resolve decision` agent preset writes the 2–4 sentence `lesson`. This is
TradingAgents' `TradingMemoryLog` (append-only, pending → resolved, plain-prose reflection)
implemented as report cards — deterministic retrieval, no embeddings.

**Agent preset `sweep debate`** (`kind:'agent'`, `attach:['sweep']`, model `opus`): the
template asks the run to spawn two Task subagents — *Bull* (argues the selected parameters
are real edge) and *Bear* (argues curve-fit, citing stability, OOS, p-value, trade count) —
for two rounds, then to judge **Adopt / Hold (insufficient evidence) / Reject**, weighing
arguments on merit independent of order. Two rounds is the counter-based terminator
(`count ≥ 2 × max_debate_rounds`); the three-way risk debate is deliberately not ported.

## 4b. What-if panel (Audit tab, right of Blockers — designed in Main.dc.html, never built)

Unchanged from the first plan: pure client-side, zero re-runs. The pass mask already encodes
every gate per bar, so "treat gate X as pass" is re-filtering `data.verdicts`
(`failedGates`/`sideFailedGates`) and showing which bars flip FIRED↔BLOCKED. The ±% outcome
column joins forward returns from `data_get_ohlcv` (also enables the artboard's +60m column
on Pattern bars).

## 4c. Multi-symbol compare (the user's SOLUSD vs ETHUSD example)

Unchanged: `pane_set_layout {layout:'2h'}` → `pane_set_symbol {index,symbol}` ×2 → per pane:
`pane_focus {index}` → `strategy_gate_audit` → two summary columns side-by-side. Verified
already: every data reader follows the *active* chart (`src/core/data.js` —
`_activeChartWidgetWV`), so focus-then-read gives true per-pane data, sequentially.
Unverified blocker: whether `chart_manage_indicator` adds a study to the focused pane or
pane 0. New note: when a later phase scores one parameter set across panes, aggregate as
the **worst symbol** (freqtrade `MaxDrawDownPerPairHyperOptLoss`), not the mean — one hero
symbol must not carry a sweep.

## Viewer — Optimize tab (`scripts/viewer/gate-audit.html:160-166`)

Artboard elements plus: parameter rows picked from the shortlist (label dropdown fills type
and window), "+ add parameter", objective selector (`list()`), split date, sampler choice
with `runs N · est ~M min` (`N = countEvals`, `M = N × baseline settle`), **Run sweep** →
progress row (done/total, current inputs, elapsed vs expected) + cancel; on completion the
report is opened in place: equity-vs-baseline overlay on one axis (baseline dashed grey;
series `#3987e5 #d95926 #199e70`; never a second y-scale), selected-variant gauges with a
baseline tick and Δ stated in text, all-runs table (click to plot; columns: params…, net %,
PF, max DD, trades, IS obj, OOS PF, stability, Δ base), sweep matrix (only when exactly two
parameters; otherwise the ranked list), **verdict badge + reasons + p-value**, Apply to chart,
open report. Page reload: `GET /sweep/status` on load reattaches exactly like the agent
status polling. Edu note keeps the artboard's caveat verbatim; `GLOSSARY` gains `objective`,
`stability`, `decision log`. Size ceiling **84 → 100 KB**.

## File-by-file change list

| File | Change |
|---|---|
| `src/core/paramspace.js`, `src/core/objectives.js`, `src/core/sweep.js` (new, pure) | as specified above; exported via `src/core/index.js` |
| `scripts/sweep-job.js` (new) | job state, loop, journal, restore, timeout |
| `scripts/http-bridge.js` | `/sweep*` routes, shared busy lock with `/agent`, `reports/sweeps/` dir, `/health.sweep`, 404 text |
| `profiles/pf3g-vp.json` | `optimize.shortlist` (table above); `loadProfile()` unchanged |
| `scripts/viewer/gate-audit.html` | Optimize tab (`:160-166`), `META_JS` + `min/max/step/options` (`:506-510`), presets `sweep` (js), `sweep debate` (agent), `resolve decision` (agent), GLOSSARY |
| `src/tools/backtest.js` | `strategy_sweep_plan` (returns the expanded plan and count for a space — used by the CLI and the viewer's estimate) |
| `src/cli/commands/sweep.js` (optional) | `tv sweep plan --space space.json`, `tv sweep run` against a running bridge |
| `tests/paramspace.test.js`, `tests/objectives.test.js`, `tests/sweep.test.js` (new) | pure-function coverage (below) |
| `tests/http_bridge.test.js` | `/sweep` lifecycle with the stub tool, 409 lock vs `/agent`, journal resume, ceiling `84 → 100 KB` |
| `tests/fixtures/stub-mcp-server.js` | `strategy_run_backtest` stub with a per-inputs deterministic RunCard |
| `docs/VIEWER_GUIDE.ko.md` | Optimize tab section once live |

## Tests to add (all without TradingView)

- `paramspace`: `expandGrid` count and order; cap → throws with the count; decimals rounding
  (`0.1 + 0.2` style drift never reaches `values`); `neighbors` at the edges of a range;
  `resolveLabels` unresolved label → error naming it.
- `objectives`: each formula against hand-computed fixtures; `null` for missing inputs;
  `multi_metric` penalty at n = 5 / 30 / 60; monotonicity (more profit → smaller value).
- `sweep`: ranking, OOS check, plateau-vs-peak selection on a synthetic 4 × 4 matrix,
  verdict rules for each branch, decision resolution by `configHash`.
- `http_bridge`: start → status → cancel restores; resume after a simulated restart
  continues at the right index; `/sweep` while `/agent` busy → 409 and vice-versa.

## Open questions to verify at phase start (live chart)

1. `metaInfo` numeric bounds (shared with Phase 3 question 3).
2. Settle-time distribution on the real chart → default `expectedMs` and whether 15 s holds.
3. `setInputValues` for string inputs: option label or index? (affects categorical values).
4. Determinism: does baseline-after-restore reproduce baseline-before exactly (`restore.verified`)?
5. TradingView Desktop memory/CPU after 64 recomputes in one session.

## Risks

- Minutes-long automation against a live chart remains the fragile end of the plan:
  serialized, paced, cancellable, journaled, inputs restored in `finally`; one settle timeout
  per run, no auto-retry.
- Sweep results invite overfitting; 4a.5 exists to undersell the winner, and the UI states
  verdict and reasons in text, never in colour alone.
- If `restore.verified` is false the report says so first: results are then not comparable
  to the live chart.

## Verification sketch (when implemented)

Shortlist Trend Gate Mode × ER Range Threshold 0.20 → 0.35 → 8 runs → journal has header +
8 run lines + end → matrix and overlay render → verdict computed with reasons → cancel
mid-sweep restores inputs (`data_get_indicator` before/after equal) → kill and restart the
bridge mid-sweep, `POST /sweep/resume` finishes the remaining runs → `npm run test:unit`
green at 100 KB.
