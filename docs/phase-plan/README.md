# Gate Audit Viewer v2 — Phase Plans

> Last updated: 2026-09-03
> Why this directory exists: earlier plans lived only in `~/.claude/plans/` (overwritten every
> phase) and in a Claude Artifact that survived a profile wipe by luck. Plans now live in git.

The recovered design canvas (artifact `eb0591ae`, "Gate Audit Viewer") defined a 4-tab layout —
**Audit · Reports · Backtest · Optimize** — labelled *"design only — engine not built"*.
These documents track turning that design into a working command surface (an **Alerts** tab
was added along the way, so the viewer now has five tabs).

| Phase | Scope | Status | Commits |
|---|---|---|---|
| [1](./phase-1-tabs-smart-prompt.md) | Tab shell · smart prompt · deterministic presets · Edu mode | ✅ shipped | `659d5bc` |
| [1.5](./phase-1.5-pills-chips.md) | Pill toggle · attach-to-prompt chips · auto-fill pills | ✅ shipped | `f222c4d` |
| [2](./phase-2-agent-reports.md) | send-to-Claude agent runs · Reports archive · model routing | ✅ shipped | `b449237` `c6ce861` `acb5d45` |
| 2.1 | Alerts tab · health flags · on/off toggle · delete behind a confirm gate | ✅ shipped | `061c607` `bac512b` `2126a65` |
| [3](./phase-3-backtest.md) | Backtest tab — `RunConfig`/`RunCard`, tester settle detection, normalized metrics, validation (IS/OOS · walk-forward · Monte-Carlo), `POST /reports` | 📋 redesigned 2026-09-03 | — |
| [3.5](./phase-3.5-bias-checks.md) | Bias checks — repaint/lookahead via replay, history sensitivity | 📋 optional | — |
| [4](./phase-4-optimize.md) | Optimize tab — typed parameter space, objective registry, resumable bridge sweep job, verdict + decision log · What-if panel · multi-symbol compare | 📋 redesigned 2026-09-03 | — |

**Redesign 2026-09-03** (Phase 3/4 reviewed against the code and against ten open-source
trading repos): [what changed, how and why](./phase-3-4-redesign-notes.ko.md) ·
[which pattern came from which repo, and what was left out](./functional-spec-sources.ko.md).

Related: user manual [`../VIEWER_GUIDE.ko.md`](../VIEWER_GUIDE.ko.md) ·
outstanding side-deliverable: `docs/PROMPT_CATALOGUE.md` (planned in the v2 master plan, not yet written).

## Standing constraints (apply to every phase)

- Branch `my-changes` only. **Never PR, never merge to `main`.**
- `scripts/viewer/gate-audit.html` stays a single file: vanilla JS, inline CSS, canvas,
  **no build step, no external dependencies** (test-enforced self-containment; size ceiling
  raised deliberately per phase — currently 70 KB at `tests/http_bridge.test.js:205`, planned
  84 KB for Phase 3 and 100 KB for Phase 4).
- The bridge (`scripts/http-bridge.js`) is the only network path; `POST /call` is a generic
  MCP tool proxy — new deterministic commands need no bridge changes. Anything that runs for
  minutes (agent runs, parameter sweeps) is a bridge **job** with status/cancel/resume
  (`/agent`, `/sweep`), never a single `/call`.
- TradingView's live Strategy Tester is the **only** backtest engine. Phase 3/4 add a
  validation layer around it; no simulator is written (canvas note, 2026-08-28).
- Palette and layout follow the recovered artboards (`#1a1a19` bg, `#7aa2f7` accent, mono type).
