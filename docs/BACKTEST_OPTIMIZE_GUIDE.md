# Backtest and Optimize — how to use them

Two interactive flow diagrams sit alongside this page. Open them in a browser; they pan, zoom,
search, trace a relationship, and step through guided views. Everything is inline in one file,
so they work offline and need no server.

| Flow | Diagram | What it answers |
|---|---|---|
| Run one backtest | [**backtest-flow.html**](./flows/backtest-flow.html) | What do I click, what happens after Run, why might it refuse |
| Sweep and decide | [**optimize-flow.html**](./flows/optimize-flow.html) | How a sweep runs, why it undersells its winner, what a decision means |

Sources: [`flows/backtest-flow.workflow.json`](./flows/backtest-flow.workflow.json) ·
[`flows/optimize-flow.workflow.json`](./flows/optimize-flow.workflow.json). Regenerate with the
`archify` skill after editing either one.

## Before anything else: you need a strategy

Both features read TradingView's **Strategy Tester**, and only a `strategy()` script has one.
An `indicator()` script produces no report, no trades and no equity — the tester just says
"Add strategy to this chart".

```bash
# which studies on the chart are real strategies?
curl -s -H "Authorization: Bearer $MCP_BRIDGE_TOKEN" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3001/call -d '{"tool":"chart_get_state","params":{}}'
# → studies[] entries carry is_strategy: true when they qualify
```

PF 3G VP is an indicator, so it is **not** a backtest subject. For that script use
`strategy_gate_audit` and the Audit tab instead ([GATE_AUDIT_GUIDE.md](./GATE_AUDIT_GUIDE.md)).

## Part 1 — Run one backtest

Open the viewer (`http://127.0.0.1:3001/viewer`), paste the bridge token once, then pick the
**Backtest** tab. The tab reads the chart itself: strategy name, symbol, timeframe, Pine version
and the full input list.

1. **Configure.** Add input overrides from the picker (each is an `in_N` id behind a readable
   label), set a split date, set the account size, and decide whether to restore your inputs when
   the run ends. Leave restore off to keep the run visible on the chart; turn it on to put your
   settings back.
2. **Run.** One call does everything server-side: snapshot the current inputs, apply only the ones
   that actually change, wait for the tester to settle, then read report, trades and equity in a
   single snapshot so all three come from the same instant. Typical settle is 2–8 s.
3. **Read the results.** The verdict pill, the metric table with a per-key source tag, the
   validation block, the trade table and the equity curve.
4. **Save as report** if you want to keep it. It lands in the Reports tab next to your analyses.

### From an agent or the CLI instead

```bash
# through the bridge (what the viewer does)
curl -s -H "Authorization: Bearer $MCP_BRIDGE_TOKEN" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3001/call -d '{
    "tool": "strategy_run_backtest",
    "params": { "inputs": "{\"in_1\": 4}", "split_date": "2026-08-01T00:00:00Z", "restore": true },
    "timeoutMs": 90000 }'

# or the CLI
tv backtest run -i '{"in_1": 4}' -s 2026-08-01 -r --md
```

### Reading a RunCard

| Field | How to read it |
|---|---|
| `metricSources[key]` | `both` means TradingView and our independent recomputation agree. `tv` means only the tester reported it. `computed` means we derived it from the trade list. |
| `verdict` | `edge` needs p < 0.05, a positive out-of-sample profit factor and 30+ trades. `noise` is the honest default. `insufficient` means too few trades or an unsettled read — a hold, not a failure. |
| `warnings` | `unsettled` (the tester never stabilised), `no_report` (it never computed), `no_change` (your overrides matched the current values), `metrics_mismatch:<key>`, `few_trades`. |
| `openTrades` | TradingView lists a still-open trade but excludes it from net profit; so do we. |

Percentages are plain numbers: `netProfitPct: -3.79` means −3.79 %.

## Part 2 — Sweep and decide

The **Optimize** tab seeds its axes from the strategy's own input metadata, or from the profile
shortlist when the profile matches the study.

1. **Compose the space.** Add parameters, edit each one's comma-separated value list, pick an
   objective and a sampler, and set the split date. The estimate updates live; a grid over 64
   points is refused rather than run.
2. **Run the sweep.** It becomes a bridge job, not a single call, so it survives a page reload:
   progress reattaches from `GET /sweep/status`. A baseline runs first, then one backtest per
   point, each appended to `reports/sweeps/<id>.jsonl`.
3. **Apply the winner** if you accept it. That writes the inputs to the chart and records a
   **pending decision**.

A later backtest of the same configuration, once new bars have closed, resolves that decision with
what actually happened out of sample.

```bash
# start a sweep
curl -s -H "Authorization: Bearer $MCP_BRIDGE_TOKEN" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3001/sweep -d '{
    "study": "My Strategy",
    "splitDate": "2026-08-01T00:00:00Z",
    "space": { "params": [{ "id": "in_1", "label": "Factor", "type": "decimal", "values": [3, 3.5, 4] }],
               "sampler": { "kind": "grid" } } }'

curl -s -H "Authorization: Bearer $MCP_BRIDGE_TOKEN" http://127.0.0.1:3001/sweep/status
```

### Things the sweep does on purpose

- **It owns the chart.** Every point writes real inputs to your live study, so an agent run is
  refused with 409 while a sweep is active, and vice versa.
- **It always puts your inputs back**, in a `finally` block, then reads them back to prove it —
  after a normal finish, a cancel, or a timeout. If the read-back disagrees, the viewer says so and
  prints the values to re-apply by hand.
- **It survives a crash.** Kill the bridge mid-sweep and `POST /sweep/resume {id}` replays the
  journal and finishes the remaining points. Resuming a finished sweep is refused with 409.
- **It undersells the winner.** Ranking blends the objective with neighbour stability, so a
  settings region whose neighbours are also good beats an isolated spike. Under eight settled runs
  the verdict is `insufficient` no matter how good the best number looks.

### Why a decision stays open

Applying a winner claims nothing. The decision records the configuration hash and the applied run's
own last trade time, and stays `pending` until a later backtest of that same configuration covers
bars beyond it. Only then does it record the realised out-of-sample figures and whether the choice
held. A parameter set that trades less often simply waits longer — that is the point.

## Common stops

| What you see | What it means |
|---|---|
| "no strategy on this chart" | The chart has no `strategy()` script. An indicator cannot be backtested. |
| `unsettled` warning | The tester signature never changed and settled. Common when your overrides produced the same result as the previous run. |
| `no_report` warning | The tester has not computed at all. Usually a wedged script — see below. |
| 409 on `/sweep` or `/agent` | The other kind of job holds the chart. Wait or cancel it. |
| Grid refused before running | More than 64 evaluations. Narrow a range or switch the sampler to random or halving. |

**One input value can wedge a strategy.** A categorical input takes its **option label**, never the
option's index. TradingView accepts an out-of-range value, reads it back as written, and then stops
computing the script permanently — only removing and re-adding the study recovers it.
`indicator_set_inputs` validates against the study's declared metadata and refuses the whole batch
rather than writing, so this cannot happen through the tools; it is worth knowing if you edit
inputs by hand in the UI.

## Related

- Specs: [phase-plan/phase-3-backtest.md](./phase-plan/phase-3-backtest.md) ·
  [phase-plan/phase-4-optimize.md](./phase-plan/phase-4-optimize.md)
- Implementation and live findings (Korean):
  [phase-plan/phase-3-4-implementation-notes.ko.md](./phase-plan/phase-3-4-implementation-notes.ko.md)
- Viewer manual (Korean): [VIEWER_GUIDE.ko.md](./VIEWER_GUIDE.ko.md)
