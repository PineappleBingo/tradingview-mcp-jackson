# Phase 3 — Backtest tab: reproducible runs + a trust layer around the live Strategy Tester

**Status: ✅ implemented and verified on a live chart 2026-09-04** (commits `c64f82f` core · `086f606` bridge · `692b723` viewer, then the live-fix commit; see [implementation notes](./phase-3-4-implementation-notes.ko.md) for what differs from this spec)

> The first live run found that **none of it worked against a real Strategy Tester**: the strategy
> locate idiom matched the wrong study on every chart, and the payload shapes the code expected
> are not the shapes TradingView Desktop 3.4 returns. Both are fixed and re-verified end to end;
> the answers are in [Open questions — answered live](#open-questions--answered-live-2026-09-04).
Korean companions: [what changed and why](./phase-3-4-redesign-notes.ko.md) · [where each pattern comes from](./functional-spec-sources.ko.md)

## Principle (unchanged)

Read the **live TradingView Strategy Tester** — no simulator is written. The recovered
`Backtest.dc.html` artboard says exactly this, and the survey of ten open-source trading
repos confirmed it: every engine out there needs its own data feed and fill model; ours is
already on the chart. What the survey *did* expose is that every serious backtester wraps
its engine in three things we lack — a **reproducible run record**, a **stable metrics
schema**, and a **validation layer** that says how much to trust a number. Phase 3 adds
those three around the tester instead of replacing it.

## Why the first plan would not have worked as written

| # | Assumption in the 2026-08-31 plan | Reality in the code |
|---|---|---|
| 1 | "Save as report → `POST /reports`" | No `POST /reports` route exists. `scripts/http-bridge.js:437-457` serves only `GET /reports`, `GET /reports/:id`, `DELETE /reports/:id`; reports are written solely by the agent run's exit handler (`:298-309`). |
| 2 | "`indicator_set_inputs` … wait/poll" | `setInputs()` returns the instant `study.setInputValues()` is called (`src/core/indicators.js:32`). Nothing in the repo waits on the tester; `waitForChartReady()` (`src/wait.js:6`) watches the symbol spinner and bar count, not the strategy. |
| 3 | "Run = a sequence over the existing `call()` helper" | Each `POST /call` has a hard 30 s timeout (`send()`, `scripts/http-bridge.js:98-111`), and a browser-side sequence cannot be reused by the CLI, the `strategy-report` skill or the `performance-analyst` agent, nor unit-tested. |
| 4 | "`data_get_trades {max_trades:200}`" | `MAX_TRADES = 200` (`src/core/data.js:7`) and `getTrades()` slices from the **front** of `ordersData()` (`:197`), so a strategy with 600 trades returns the oldest 200. Validation needs the whole list. |
| 5 | Key-metrics table with fixed rows | `getStrategyResults()` (`src/core/data.js:144`) returns whatever keys `reportData()` holds — no schema, no normalisation, no fallback when a key is missing. |
| 6 | Edu note: "a direction, not a result" | The caveat had no mechanism behind it: no in-sample/out-of-sample split, no walk-forward, no Monte-Carlo, no trade-count guard anywhere in the repo. |
| 7 | (implicit) viewer growth | Viewer is 68,484 bytes against a 70 KB ceiling (`tests/http_bridge.test.js:205`) — 3.1 KB of headroom for a whole tab. The test comment already reserves the next bump for Phase 3. |

## Architecture

```
viewer (Backtest tab) ──POST /call {tool:'strategy_run_backtest', timeoutMs:60000}──▶ bridge ──stdio──▶ MCP server
        │                                                                                        │
        │                                                        src/core/backtest.js: runBacktest()
        │                                                          ├─ getIndicator()        (src/core/data.js:118)   snapshot original inputs
        │                                                          ├─ setInputs()           (src/core/indicators.js:8)
        │                                                          ├─ waitForTesterSettle() (src/wait.js, new)
        │                                                          ├─ readStrategySnapshot()(new, one CDP evaluate)
        │                                                          ├─ normalizeMetrics()    (new)
        │                                                          ├─ validate()            (src/core/validate.js, new, pure)
        │                                                          └─ finally: restore inputs when config.restore
        └──POST /reports {type:'backtest', title, summary, body_md, data:RunCard}──▶ reports/<id>.json ──▶ Reports tab
```

The CLI (`tv backtest run …`), the `strategy-report` skill and the `performance-analyst`
agent all call the same tool, so one implementation serves four surfaces.

## Data contracts

```
RunConfig  { schemaVersion:1, study:{entityId,name}, symbol, timeframe,
             inputs:{[in_N]:value}, labels:{[in_N]:string},
             restore:boolean(false), settle:{pollMs:250, stablePolls:3, timeoutMs:15000},
             splitDate?:ISO, costs:{commissionPct, initialCapital, qtyType, qtyValue}|null,
             configHash:sha1 }
  configHash = sha1(canonical JSON of {study.name, symbol, timeframe, sorted inputs, costs}).
  entityId is excluded — it is session-specific (CLAUDE.md "Tool Conventions").

RunCard    { schemaVersion:1, id, createdAt, kind:'backtest', config:RunConfig,
             settled:boolean, settleMs:number,
             warnings:('unsettled'|'inputs_not_applied:<id>'|'metrics_mismatch:<key>'
                      |'trades_truncated'|'no_equity'|'few_trades'|'no_change')[],
             window:{firstTradeTime, lastTradeTime, tradeCount},
             metrics:{netProfit, netProfitPct, totalTrades, winRate, profitFactor,
                      maxDrawdown, maxDrawdownPct, avgTrade, avgTradePct, avgWin, avgLoss,
                      expectancyRatio, sharpe, sortino, calmar, maxConsecLosses,
                      long:{trades,netProfit,winRate}, short:{trades,netProfit,winRate}},
             metricSources:{[key]:'tv'|'computed'|'both'},
             tvRaw:{…reportData() verbatim},
             trades:Trade[], equity:{points:[{t,equity,dd}], downsampled:boolean},
             validation?:ValidationResult, body_md:string }

Trade      { n, side:'long'|'short', entryTime, exitTime, entryPrice, exitPrice, qty,
             pnl, pnlPct, cumPnl, barsHeld?, entrySignal?, exitSignal? }

ValidationResult
           { split:{splitDate, is:{n,netProfit,profitFactor,sharpe}, oos:{n,netProfit,profitFactor,sharpe}}|null,
             monteCarlo:{n:1000, seed:42, pSharpe, pMaxDD, pProfitFactor},
             bootstrap:{n:1000, conf:0.95, sharpeLo, sharpeHi},
             walkForward:{nWindows:5, windows:[{from,to,n,netProfit,profitFactor}], positiveFraction},
             tradeCountPenalty:number, verdict:'edge'|'noise'|'insufficient', reasons:string[] }

Report (type 'backtest')  = existing report envelope {id, createdAt, type, title, summary, body_md, context:[]}
                            + data:RunCard.  summary/body_md keep the existing Reports detail view working unchanged
                            (`scripts/viewer/gate-audit.html` renders body_md through the escape-first markdown renderer).
```

Times are ISO strings in UTC. Money is in the strategy's account currency as reported by
TradingView; percentages are plain numbers (4.81 means 4.81 %).

## Run algorithm — `runBacktest(config, deps)`

`src/core/backtest.js`, exported through `src/core/index.js`; `deps` is injectable exactly
like `runGateAudit(params, deps)` (`src/core/gateAudit.js:180`) so the whole sequence is
unit-testable with recorded CDP payloads.

1. **Resolve** the study: `chart_get_state` → the study whose name matches `config.study.name`
   (default `/PineForge|PF 3G/i`, the same regex the viewer uses at `gate-audit.html:513`).
2. **Snapshot originals**: `getIndicator({entity_id})` → `{id,value}[]` (`src/core/data.js:118`).
   Keep only the ids in `config.inputs`. If every override equals its current value, set
   `warnings += 'no_change'` and skip steps 3–4 (the tester will not recompute).
3. **Signature before**: `testerSignature()` = one evaluate returning
   `{tradeCount, lastExitTime, netProfit, totalTrades}` from the located strategy source
   (same locate idiom as `getStrategyResults()`: first `dataSources()` entry with
   `ordersData || reportData || performance`, `src/core/data.js:151-154`).
4. **Apply**: `setInputs({entity_id, inputs})` (`src/core/indicators.js:8`). Its
   `updated_inputs` must list every id in `config.inputs`; any id missing →
   `warnings += 'inputs_not_applied:<id>'` (the id is not an input of this study).
5. **Settle**: `waitForTesterSettle({before, pollMs:250, stablePolls:3, timeoutMs:15000})`
   (new, `src/wait.js`, same poll shape as `waitForChartReady`). Poll `testerSignature()`
   every 250 ms; the run is settled when the signature has **changed from `before`** and
   then **stayed identical for 3 consecutive polls** (750 ms). The tester repopulates in
   stages (orders first, report last), which is why one stable poll is not enough. On
   timeout return `{settled:false, settleMs}` — never throw; the run continues and is
   flagged `'unsettled'`. `timeoutMs` is clamped to 60 000.
6. **Read**: `readStrategySnapshot({maxOrders:5000, maxEquityPoints:2000})` — **one** CDP
   evaluate returning `{reportData, orders, equity}` so the three views come from the same
   instant. Orders are flattened one level exactly as `getTrades()` does (`src/core/data.js:199-210`)
   but sliced from the **end** (newest kept) and capped at 5000 (`'trades_truncated'` when hit).
   Equity comes from `equityData()`, else the `bars()` walk (`:238-243`); more than 2000 points
   are stride-downsampled (`downsampled:true`). Neither source → `'no_equity'`.
7. **Normalize**: `normalizeMetrics(tvRaw, trades, costs)` (below).
8. **Validate**: `validate(trades, equity, {splitDate, initialCapital})` (pure, below).
9. **Report body**: `renderRunCardMd(card)` — the Key-metrics table, warnings, verdict line,
   IS/OOS row, and the first 20 trades, in the layout the artboard shows.
10. **Restore** (in `finally`, when `config.restore`): `setInputs` with the step-2 snapshot.
    A single Backtest-tab run defaults to `restore:false` (the user wants to see the run on
    the chart); Phase 4 sweeps always restore.

Return `{success:true, card:RunCard}`; `success:false` only when the study is missing or
CDP is down. Elapsed time is dominated by step 5 (typically 2–20 s on a 5-minute chart with
a few thousand bars).

### `normalizeMetrics()`

Two sources, one schema:

- **`tv`** — keys copied from `reportData()` through a key map that is filled in at
  phase start (open question 1). Candidate TradingView names: `netProfit`, `netProfitPercent`,
  `grossProfit`, `grossLoss`, `maxStrategyDrawDown`, `maxStrategyDrawDownPercent`,
  `totalTrades`, `percentProfitable`, `profitFactor`, `avgTrade`, `avgTradePercent`,
  `avgWinTrade`, `avgLosTrade`, `numberOfWinningTrades`, `numberOfLosingTrades`.
  Unknown keys stay in `tvRaw` untouched.
- **`computed`** — always derived from `trades[]`:
  - `netProfit = Σ pnl`; `netProfitPct = 100·netProfit/initialCapital` when `costs` is known,
    else the TV value only.
  - `winRate = wins/n`; `profitFactor = grossProfit/|grossLoss|` (`Infinity` → `null` + warning).
  - `maxDrawdown` = largest peak-to-trough fall of `cumPnl` (closed-trade equity);
    `maxDrawdownPct` relative to `initialCapital + peak`.
  - `avgTrade`, `avgWin`, `avgLoss`; `expectancy = winRate·avgWin − (1−winRate)·|avgLoss|`;
    `expectancyRatio = expectancy/|avgLoss|`.
  - `sharpe = mean(pnlPct)/std(pnlPct) · √tradesPerYear`, `tradesPerYear = n / yearsSpanned`
    (trade-based Sharpe, the freqtrade `calculate_sharpe` convention); `sortino` uses the
    downside deviation; `calmar = annualizedReturnPct / maxDrawdownPct`.
  - `maxConsecLosses`; `long`/`short` splits by `side`.
- `metricSources[key]` records which side produced the value (`both` when TV and computed
  agree within `max(1 % relative, 0.5 absolute)`); a disagreement beyond that adds
  `'metrics_mismatch:<key>'` and keeps the **TV** value in `metrics` — the tester is the
  engine of record, the recomputation is the audit. TradingView's drawdown includes open
  P&L bar by bar while ours is closed-trade, so `maxDrawdown` is expected to differ
  slightly and uses a 5 % tolerance.

### Validation module — `src/core/validate.js` (pure functions, no TradingView)

All functions take plain arrays and are deterministic under a seed, so `tests/validate.test.js`
runs without a chart.

| Function | Algorithm | Origin |
|---|---|---|
| `splitByDate(trades, splitDate)` | IS = trades with `exitTime < splitDate`, OOS = the rest; metrics for each via `normalizeMetrics`. Every TradingView run covers the full loaded history, so IS/OOS is a **post-hoc** split — no Deep-Backtesting UI automation is required. | freqtrade `--timerange` then re-backtest on the held-out range |
| `monteCarloPermutation(trades, {n:1000, seed:42})` | Shuffle the order of `pnl` values `n` times (seeded PRNG), recompute Sharpe, max drawdown and profit factor for each ordering; `p = share of shuffles at least as good as the observed`. Low `pSharpe` means the observed sequence is unlikely under "same trades, random order". | Vibe-Trading `validation.monte_carlo_test` |
| `bootstrapSharpeCI(returns, {n:1000, conf:0.95, seed:42})` | Resample `pnlPct` with replacement, Sharpe per sample, percentile interval. | Vibe-Trading `validation.bootstrap_sharpe_ci` |
| `walkForwardWindows(trades, {nWindows:5})` | Split the trade list into 5 equal-count consecutive windows; net profit and profit factor per window; `positiveFraction = windows with netProfit > 0 / 5`. `stable` when `≥ 3/5`. | Vibe-Trading `validation.walk_forward_analysis` |
| `tradeCountPenalty(n, {target:30})` | `1` when `n ≥ 30`, else `max(0.1, 1 − |n − 30|/30)`. | freqtrade `MultiMetricHyperOptLoss` (target 50 there; 30 fits a 27-day 5-minute window) |
| `verdict(card)` | `insufficient` when `n < 30` or `!settled`; `edge` when `pSharpe < 0.05 ∧ OOS profitFactor > 1 ∧ n ≥ 30` (OOS only when a split exists); otherwise `noise`. `reasons[]` lists which rule fired. | TradingAgents research-manager judge with the explicit "Hold when evidence is insufficient" escape hatch |

## Bridge changes (`scripts/http-bridge.js`)

| Change | Where | Detail |
|---|---|---|
| `POST /reports` | after the list branch at `:440-449` | Body `{type, title, summary?, body_md, data?}`. `type` allow-list `['backtest','sweep','decision']` (agent runs keep writing `'analysis'` internally); body cap 5 MB; id from `newId()` (`:153`), validated by `SAFE_ID` (`:154`); writes `reports/<id>.json` with the existing envelope fields plus `data`; returns `{id}`. Token-gated like everything else. |
| `timeoutMs` on `/call` | `send(method, params, timeoutMs = 30_000)` at `:98`; `callTool()`; the `/call` handler at `:471-501` | Optional body field, clamped to 1 000–120 000. Default unchanged so Phase 1/2 behaviour is byte-identical. The Backtest tab passes 60 000. |
| `/health` | `:388` | Adds `postReports:true` so the viewer can feature-detect the Save button. |
| 404 text | `:503` | Lists the new route. |

`GET /reports` keeps projecting only `{id, createdAt, type, title, summary, context, model}`
(`:444`) — the `data` payload is fetched per report.

## Viewer — Backtest tab (`scripts/viewer/gate-audit.html:152-158`)

Layout follows the artboard: **1 · configure → 2 · run → 3 · results → 4 · save as report**.

- **Configure card**: strategy version (from `metaInfo().pineVersion` via the existing
  `META_JS` probe, `:506-510`), symbol and tf (from `chart_get_state`), split date
  (replaces the artboard's start/end pair — end is always "now", the split date is what
  IS/OOS needs), input overrides as label→value rows. Labels and ids come from the same
  join `settingsText()` already does (`:511-543`): `META_JS` for `{id,name,type,group,defval}`,
  `data_get_indicator` for current values. The "202 available" count in the artboard is
  `meta.filter(m => /^in_/.test(m.id) && m.type !== 'color').length`.
- **Run**: `call('strategy_run_backtest', {config}, {timeoutMs:60000})` — `call()` (`:188`)
  gains an optional third argument that is forwarded as `timeoutMs`. Button text while
  running: `running… settle 0.0s`, driven by a local timer; the response's `settleMs`
  replaces it. `settled:false` shows an amber pill "unsettled — values may be stale".
- **Results**: equity polyline on a `<canvas>` via `prep()` (`:227`) in `drawStrip()` styling;
  Key-metrics table (the artboard's seven rows + verdict line + IS/OOS row when a split
  exists); warnings list; trades table (last 200) reusing `drawTable()`'s sort pattern (`:300`).
- **Save as report**: `POST /reports {type:'backtest', title, summary, body_md, data:card}`
  → `location.hash = 'reports/<id>'`. Reports tab needs no change: it already prints `r.type`
  (`:944`) and renders `body_md`.
- **Prompt bar**: two new `PRESETS` entries (`:545-571`): `backtest` (`kind:'js'`, `text()`
  returns the run card markdown of the last run, so it can be shown or attached) and
  `review backtest` (`kind:'agent'`, `attach:['backtest']`, model `sonnet`, template:
  "Review the attached backtest run card as a performance analyst: profitability,
  consistency, risk, edge quality; state whether the verdict is justified; give three
  concrete input changes to test next.").
- **Edu**: `.edu-note` per card; `GLOSSARY` (`:973-982`) gains `p-value`, `walk-forward`,
  `in-sample / out-of-sample`.
- **Size**: raise the ceiling **70 → 84 KB** in `tests/http_bridge.test.js:205` with an
  intent comment (Backtest ≈ 12 KB by the Alerts-tab precedent of 22 KB for a heavier tab).

## File-by-file change list

| File | Change |
|---|---|
| `src/wait.js` | add `waitForTesterSettle({before, pollMs, stablePolls, timeoutMs})` next to `waitForChartReady` (`:6`); export `testerSignature()` |
| `src/core/backtest.js` (new) | `runBacktest(config, deps)`, `readStrategySnapshot()`, `normalizeMetrics()`, `renderRunCardMd()`, `configHash()` |
| `src/core/validate.js` (new) | `splitByDate`, `monteCarloPermutation`, `bootstrapSharpeCI`, `walkForwardWindows`, `tradeCountPenalty`, `verdict`, seeded PRNG (mulberry32) |
| `src/core/index.js` | export the two modules |
| `src/tools/backtest.js` (new) | `registerBacktestTools(server)` — `strategy_run_backtest` (zod: `config` JSON string or object) following the pattern at `src/tools/gateAudit.js:5-15`; `jsonResult` from `src/tools/_format.js` |
| `src/server.js` | import + `registerBacktestTools(server)` beside `registerGateAuditTools` (`:80`); tool count in the `instructions` string |
| `src/cli/commands/backtest.js` (new) + `src/cli/index.js` | `tv backtest run --inputs '{...}' --split 2026-08-15 --restore` printing the markdown body |
| `scripts/http-bridge.js` | `POST /reports`, `timeoutMs`, `/health.postReports`, 404 text (table above) |
| `scripts/viewer/gate-audit.html` | Backtest tab markup + JS (`:152-158`), `call()` third arg (`:188`), two presets (`:545-571`), GLOSSARY (`:973-982`) |
| `tests/http_bridge.test.js` | ceiling `70 → 84 KB` (`:205`); `POST /reports` round-trip; `timeoutMs` clamp; `/health.postReports` |
| `tests/fixtures/stub-mcp-server.js` | stub `strategy_run_backtest` returning a canned RunCard |
| `tests/backtest.test.js` (new) | `runBacktest` with recorded deps: settle success, settle timeout → `'unsettled'`, `'no_change'`, `'inputs_not_applied'`, restore called in `finally` even when reading throws |
| `tests/validate.test.js` (new) | every pure function against hand-computed fixtures; seed determinism |
| `profiles/pf3g-vp.json` | no change in Phase 3 (Phase 4 adds `optimize`) |
| `skills/strategy-report/SKILL.md:12-14`, `agents/performance-analyst.md` | prefer `strategy_run_backtest` (one call, normalized metrics, verdict) over the three raw readers |
| `README.md`, `CLAUDE.md:3` | tool count (already inconsistent: README says 78, CLAUDE.md 83 — fix both to the real number) |
| `docs/VIEWER_GUIDE.ko.md` | Backtest tab section with screenshots once live |

## Tests to add (all runnable without TradingView)

- `validate.test.js`: Monte-Carlo p-value of an all-winning sequence is ≥ 0.5 (order cannot
  matter); a strongly trending sequence yields `pSharpe < 0.05`; bootstrap CI contains the
  point estimate; walk-forward windows partition the list; penalty table at n = 5, 15, 30, 60.
- `backtest.test.js`: deps record the call order `getIndicator → setInputs → signature… →
  snapshot → (restore)`; timeout path sets `settled:false`; mismatch tolerance produces
  exactly one warning per disagreeing key.
- `http_bridge.test.js`: `POST /reports` → `GET /reports` lists `type:'backtest'` → `GET /reports/:id`
  returns `data`; bad type → 400; 6 MB body → 413; `timeoutMs: 999999` clamps to 120 000.

## Open questions — answered live (2026-09-04)

Measured on TradingView Desktop 3.4.0 (Chromium 146) against COINBASE:SOLUSD · 15 with the
built-in **Supertrend Strategy** loaded. The user's own PF 3G VP script is an `indicator()`,
so it has **no Strategy Tester at all** — see "What blocked everything" below.

| # | Question | Answer |
|---|---|---|
| 1 | `reportData()` key names | Not flat. Metrics nest under `performance.{all,long,short}` (`netProfit`, `netProfitPercent`, `totalTrades`, `percentProfitable`, `profitFactor`, `grossProfit/Loss`, `avgTrade`, `avgWinTrade`, `avgLosTrade`, `numberOfWiningTrades` …) plus top-level ratios `maxStrategyDrawDown(Percent)`, `sharpeRatio`, `sortinoRatio`, `openPL`, `buyHoldReturn(Percent)`, `maxStrategyRunUp(Percent)`, `maxMarginUsed`. **Every percentage is a fraction**: `netProfitPercent: -0.0379` means −3.79 %. |
| 2 | `ordersData()` fields and time unit | `ordersData()` is the raw **fill** list (`{b,c,e,id,p,q,tm,tp}`, `tm` = bar index), not trades. The closed-trade list is **`reportData().trades`**: `{e:{c,p,tm,b,tp}, x:{…}, q, tp:{v,p}, cp:{v,p}, rn:{v,p}, dd:{v,p}, cm}`, times in **milliseconds**, side in `e.tp` (`le`/`lx`/`se`/`sx`). The **last row is the still-open trade**, which TradingView lists but excludes from `netProfit` — so we exclude it from metrics, validation and the window too. |
| 3 | Does `metaInfo().inputs[]` expose `min`/`max`/`step`/`options`? | Yes, all four. But an unbounded numeric input carries **±1e12 sentinels**, and a nominal bound (`pyramiding 0..1e6`) is useless as a sweep axis, so anything that would not enumerate to ≤ 100 values is seeded as five points around its current value instead. |
| 4 | Does `setInputValues()` recompute with the tester panel closed? | **Yes.** Verified with the bottom bar minimised (height 38 px) and with the Pine editor as the active tab: runs settled in 1.8–2.5 s with correct numbers. No `ui_open_panel` call is needed before a backtest. |
| 5 | Shape of `equityData()` | **It does not exist.** The strategy source has no `equityData`, `bars` or any bar-by-bar curve. The equity curve is therefore the **closed-trade** one — `initialCapital + trade.cp.v` at each exit — which is what the tester's Overview plots anyway. `buyHold` and `marginUsage` arrays exist but are per-trade. |
| 6 | Can costs be read from the study? | Yes — `reportData().buyHold[0]` is the initial capital (also input `in_8`), `currency` is on `reportData()`, commission on `in_9`/`in_11`. `runBacktest` now falls back to the report's capital when the caller passes none, so percent metrics are never blank. |
| 7 | Is the 5000-order cap ever hit? | Not remotely: 300 trades (299 closed + 1 open) over ~12 000 bars of 15-minute history. |
| 8 | Typical settle time — is 15 s enough? | Yes. Observed 1.5–8.0 s across ~20 runs (median ≈ 2 s; the 8 s outlier was the first run after a chart reload). The 15 s default stands. |

### What blocked everything (found only by running it)

1. **The strategy locate idiom matched any study.** Every source on the chart carries a
   `performance` watched value, so `s.metaInfo && (s.ordersData || s.reportData || s.performance)`
   returned the **Volume indicator** — first in `dataSources()`. Every strategy reader
   (`data_get_strategy_results`, `data_get_trades`, `data_get_equity`) and the whole Phase 3
   snapshot silently read an empty report and zero trades. Now: `model.activeStrategySource()`
   first, then `metaInfo().isTVScriptStrategy`, in one shared `strategySourceJS()` in
   `src/core/data.js` that all readers and the settle signature use.
2. **An `indicator()` script has no Strategy Tester.** PF 3G VP is an indicator, so the tester
   shows "Add strategy to this chart" and nothing in Phase 3/4 can run against it. `chart_get_state`
   now returns `is_strategy: true` on the studies that actually are strategies, and the run,
   the sweep job and the viewer all prefer a flagged strategy over a name match — otherwise the
   default `/PineForge|PF 3G/i` filter would keep selecting the indicator.
3. **One bad input value kills the strategy for good.** Writing an option *index* where a
   categorical input wants its *label* (`in_2: 1` instead of `"percent_of_equity"`) is accepted
   by `setInputValues()` and reads back as written — and from that moment `reportData()` is
   `null` and never recovers, through any number of recomputes; only removing and re-adding the
   study brings it back. Sweeps always enumerate option labels, so they were safe by
   construction, but nothing enforced it for a hand-written override. `setInputs()` — the one
   call every writer goes through — now validates against `metaInfo` and refuses the whole batch
   before writing, and refuses to write at all if it cannot read the metadata.
4. **Percentages were double-counted as percent.** Only `winRate` was scaled; `netProfitPct`,
   `maxDrawdownPct` and `avgTradePct` were passed through as fractions, so a −3.79 % run
   reported −0.0379 %. All four are scaled now, and TV-vs-computed agreement confirms it
   (13 of 18 metric keys come back `both`).

## Risks

- **Settle detection is heuristic.** A recompute that lands on an identical signature
  (e.g. an override that only changes drawings) times out and is flagged, not lost.
- **TradingView internals can move** (`reportData`, `ordersData` are private). The locate
  idiom and key map live in one module (`src/core/backtest.js`) so a breakage is one fix.
- **Statistics on few trades are weak.** The verdict says `insufficient` below 30 trades
  and the UI repeats the artboard's caveat; nothing in Phase 3 hides a small sample.
- **A run mutates the live chart** unless `restore` is set. The Backtest tab shows the
  applied overrides in the header until the user restores or re-runs.

## Deferred

- TradingView **Deep Backtesting** (true date-range control) — still `ui_click` automation
  of the tester panel; IS/OOS by trade timestamps removes the need for it in Phase 3.
- Fill-fragility re-scoring (NautilusTrader `FillModel` idea: what if `prob_slippage` of
  fills slipped a tick) — cheap to add on top of `trades[]`, but not needed for a verdict.

## Verification sketch (when implemented)

Configure SOLUSD·5 with one override and a split date → run → `settled:true`, metrics match
the Strategy Tester panel on screen (screenshot comparison), `metricSources` mostly `both`,
verdict line present → save → Reports tab shows a `backtest` card whose detail renders the
markdown → `npm run test:unit` green with the new ceiling → `tv backtest run` prints the same
markdown from the CLI.
