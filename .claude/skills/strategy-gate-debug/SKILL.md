---
name: strategy-gate-debug
description: Data-driven debugging loop for the PineForge volume-profile strategy (PF 3G VP) on a live TradingView chart — read per-bar gate masks, PF-TLM telemetry rows, and blocked-entry labels to explain any missing or unwanted entry. Use when asked why the strategy did or didn't trade at a specific bar, or to audit its gates without screenshots. Works with local MCP tools or, when they are unavailable (e.g., a web session), through an HTTP bridge URL via curl.
---

# Strategy Gate Debug Loop

You are debugging the PineForge 3rd Gen Volume Profile strategy ("PF 3G VP", v4.4.0+) running on a live TradingView chart. Answer "why did it (not) enter on bar X?" with data, not screenshots.

## Step 0 — Choose the transport

- **Local session (MCP tools available):** call the `tradingview` MCP tools directly (`tv_health_check`, `data_get_study_series`, ...).
- **No MCP tools in this session (e.g., Claude Code on the web):** ask the user for their bridge URL and token, then use curl for every call:

  ```bash
  curl -s "$TV_BRIDGE_URL/health" -H "Authorization: Bearer $TV_BRIDGE_TOKEN"
  curl -s "$TV_BRIDGE_URL/call" -H "Authorization: Bearer $TV_BRIDGE_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"tool":"data_get_study_series","params":{"study_filter":"PF 3G","plot_filter":"Audit","count":200}}'
  ```

  The user starts the bridge on the machine running TradingView Desktop with
  `MCP_BRIDGE_TOKEN=<secret> node scripts/http-bridge.js` and exposes it with
  `ngrok http 3001` or `cloudflared tunnel --url http://localhost:3001`
  (see `docs/DEBUG_WORKFLOW_GUIDE.md`). Never proceed over a tunnel without a token.

## Step 1 — Verify the chart

1. `tv_health_check` → CDP connected?
2. `chart_get_state` → confirm a study whose name contains "PF 3G" is on the chart; note symbol/timeframe.

If the strategy is missing, stop and tell the user to add it.

## Step 2 — Enable telemetry (once)

Ask the user to enable **Diagnostics → "Debug Telemetry Table (MCP)"** in the indicator settings (default off). Without it you still have the audit plots and labels; with it you get timestamped per-bar rows.

## Step 3 — Pull the per-bar gate history

`data_get_study_series {study_filter: "PF 3G", plot_filter: "Audit", count: 200}`

This returns per-bar values of every `Audit *` plot — the tool for history; `data_get_study_values` only shows the last bar. Key columns:

- `Audit Final Entry Pass Mask` — the gate verdict per bar (bit table below)
- `Audit Efficiency Ratio` — Kaufman ER; < 0.25 is range territory
- `Audit Range Regime State` — encoded: hundreds = regime active (100), tens = structural evidence score 0–3, ones = POC whipsaw suppression (1 bull / 2 bear)
- `Audit Long|Short Execution Reason` — pattern codes 1–8 (0 = no pattern)
- `Audit D-Shape State Mask`, `Audit D-Shape Rotation Gate Mask` — D filter internals

## Step 4 — Decode the mask

`Audit Final Entry Pass Mask`: each bit = that gate PASSED. **A zero bit is the blocker.** All-pass = 65535.

| Bit | Value | Long gate      | Bit | Value | Short gate      |
|-----|-------|----------------|-----|-------|-----------------|
| 0   | 1     | allowLong      | 6   | 64    | allowShort      |
| 1   | 2     | Room           | 7   | 128   | Room            |
| 2   | 4     | Proximity      | 8   | 256   | Proximity       |
| 3   | 8     | Trend          | 9   | 512   | Trend           |
| 4   | 16    | D-Shape        | 10  | 1024  | D-Shape         |
| 5   | 32    | confirmed      | 11  | 2048  | confirmed       |
| 12  | 4096  | Macro (long)   | 13  | 8192  | Macro (short)   |
| 14  | 16384 | Regime (long)  | 15  | 32768 | Regime (short)  |

Reason codes (1–8): 1 Absorption · 2 Pin/POC Rebound · 3 Engulfing · 4 Piercing · 5 Inside-bar Breakout · 6 Setup-Extreme Impulse · 7 Healthy Breakout · 8 Healthy Breakout + FVG. A label like `X8·MAC` = pattern 8 recognized, blocked by the Macro gate.

Blocker short codes and their governing inputs:

| Code | Gate | Governing inputs |
|------|------|------------------|
| RGM  | Range Regime | group "2F Range Regime Gate" (ER thresholds, scope, confirmation bars) |
| MAC  | Confirmed b/P Macro | "Confirmed Profile Macro Bias", "Macro Bias Recovery Closes" |
| TRD  | Trend gate | "Trend Gate Engine", "Trend Gate Mode" |
| PRX  | POC proximity | "Structural POC Proximity Guard", "Minimum Structural Room (ATR)" |
| ROOM | Target room | "Require cost-adjusted next POC room", "Projected Target Policy" |
| DSHP | D-Shape filter | "D-Shape Filter Mode", "Boundary Settlement Bars" |

## Step 5 — Cross-check with telemetry and labels

- `data_get_pine_tables {study_filter: "PF 3G"}` → `PF-TLM` rows:
  `TLM|t=2026-08-26T13:03|mask=49149|dir=L|rsn=8|blk=MAC|er=0.18|rgm=1|ev=2/3|shp=D/D|vr=0.92|va=in|tgt=97.66@1.2`
  (t = UTC bar time, vr = volume/baseline ratio, ev = regime evidence score, tgt = long target POC @ ATR room)
- `data_get_pine_labels {study_filter: "PF 3G"}` → X labels carry the blocker suffix; hover tooltips carry `t=` timestamps.
- `capture_screenshot {region: "chart"}` only for final visual confirmation.
- To re-walk a window live: `replay_start {date: "..."} → replay_step → repeat Step 3`.

## Step 6 — Verdict template

Report per investigated bar:

```
[bar time UTC] mask=<value> → failing bit(s): <gate name(s)>
metrics: ER=<..> vol/baseline=<..> evidence=<../3> shapes=<macro/live> target=<poc@room>
cause: <one sentence>
governing input: <input name + current implication>
suggestion: <parameter change or logic follow-up, if warranted>
```

## Caveats

- Labels have **no timestamps** in compact mode — use the tooltip `t=` field or PF-TLM rows to place them on bars.
- `data_get_study_values` is last-bar only; always prefer `data_get_study_series` for history.
- `src/core/data.js` and `src/core/stream.js` read pine primitives with different field shapes; verify with `ui_evaluate` before extending either.
- On the first live run of `data_get_study_series`, if it errors, confirm the exportData schema field names with:
  `ui_evaluate {code: "window.TradingViewApi._activeChartWidgetWV.value().exportData({includeTime:true,includeSeries:false,includeStudies:true}).then(r => ({schemaSample: r.schema.slice(0,5), rows: r.data.length}))"}`
- Full reference (Korean): the strategy repo's `docs/mcp-debug-workflow.md`.
