# Phase 2 — send to Claude, job-style /agent, Reports archive, model routing

**Status: ✅ shipped** — commits `b449237` (agent+reports), `c6ce861` (model routing),
`acb5d45` (screenshots + reports auto-refresh) — 2026-08-31

## Problem

The composed prompt (user text + attached `### context:` blocks) dead-ended at the clipboard.
Requested UX, verbatim intent: a button that **sends the prompt to Claude and runs it**;
**running…** while it runs and a **blocked second run**; on completion a **summary in the
chat** plus a link to **open the detailed report in a new window**.

## Architecture decision

The browser has no model access. Three candidates were weighed:

| Option | Verdict |
|---|---|
| Clipboard handoff | kept only as the degraded fallback (agent disabled) |
| **Bridge shells out to the local `claude` CLI** | **chosen** — reuses `.mcp.json`, all `.claude/skills/*`, and the user's existing auth; no API key handling |
| Bridge calls the Anthropic API directly | rejected — re-implements an agent loop the CLI already provides |

**Key simplification found during planning:** the requested UX (running → summary → report)
needs **no streaming**. The `--output-format stream-json` relay from the first draft was
deleted; `/agent` became a buffered **job** — which also made runs survive page reloads.

## Bridge surface

| Endpoint | Behavior |
|---|---|
| `POST /agent` | `{prompt, title?, context?, model?}` → `{id, model}`; 409 while busy; spawns `claude -p` buffered, 5-min kill timer |
| `GET /agent/status` | `{busy, state, model, elapsedMs, reportId?, error?}` (in-memory; bridge restart forgets) |
| `GET /reports` · `GET/DELETE /reports/:id` | flat `reports/*.json` store (gitignored); ids sanitized `/^[a-z0-9-]+$/` |
| `GET /health` | gains `agent`, `defaultModel`, `models` for viewer feature-detection |

## Security posture (the part that needed explicit user OK)

`/agent` is prompt-driven code execution on the host:
- opt-in `MCP_BRIDGE_ALLOW_AGENT=1` **and** token-gated; endpoints 404 without the flag
- pinned argv, no shell: `--allowedTools mcp__tradingview Read Grep Glob`;
  **never** `--dangerously-skip-permissions`
- one run at a time; `MCP_BRIDGE_*` stripped from the child env (token cannot leak/recurse)
- **never enable behind a tunnel** (stated in code comments and the 404 message)

## Model routing (added after the user asked "which model runs?")

Without `--model`, runs inherited the CLI default — at the time `claude-opus-5[1m]`, i.e. the
most expensive model reading data, and `/model` in the terminal silently changed viewer costs.
- `--model` is now always passed; value validated against `['sonnet','opus','haiku']` —
  an unknown value falls back rather than reaching argv (verified with an injection probe:
  `model: "--dangerously-skip-permissions"` → fell back to sonnet).
- Default **sonnet** (env-overridable via `MCP_BRIDGE_AGENT_MODEL`); **opus** where reasoning
  earns it: `why blocked + code review`, `✎ verify entries`.
- The model is recorded on every report and shown in the chat line, report cards and detail.

## Viewer flow

feature-detect via `/health.agent` → button becomes `send to Claude`, agent pills enable,
model dropdown appears (persisted) → send posts the exact composed string → chat ticks
`running… m:ss`, controls disabled, reload reattaches via status polling → on completion the
line becomes the report summary + `open report ↗` (`/viewer#reports/<id>`, new window) →
Reports tab lists cards; detail renders markdown via a ~30-line escape-first regex renderer.
Agent pills are chip compositions: auto-attach their data via the shared `p.text()`, then send.

## Verification (as run)

- Tests 78→80: fake `claude` PATH shim (`tests/fixtures/fakebin/claude`) covers the full job
  lifecycle — 404 without flag, 401 without token, 409 while busy, report saved/listed/
  fetched/deleted, unsafe id → 400. Size ceiling 40→48 KB.
- Live: real `claude -p` smoke run (12.8 s) and a genuine sonnet analysis (41 s) of real
  blocked entries; default-model probe answered `claude-sonnet-5`.
- Browser (Chrome 152 via Playwright): token connect, routing, toggle/attach, Edu, full run
  → saved report rendered. Screenshots in `docs/images/`, wired into `VIEWER_GUIDE.ko.md`.

## Honest footnotes

- A stale reports list was first misdiagnosed as HTTP caching; the actual cause was that
  hash-only navigation doesn't reload the page. `Cache-Control: no-store` on JSON was kept
  as correct practice, and the real gap (run finishing while Reports is open) got an
  in-place refresh in `acb5d45`.
- Job state is in-memory: a bridge restart mid-run kills the child and no report appears.
