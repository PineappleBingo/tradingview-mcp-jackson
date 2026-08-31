# Gate Audit Viewer v2 — Phase Plans

> Last updated: 2026-08-31
> Why this directory exists: earlier plans lived only in `~/.claude/plans/` (overwritten every
> phase) and in a Claude Artifact that survived a profile wipe by luck. Plans now live in git.

The recovered design canvas (artifact `eb0591ae`, "Gate Audit Viewer") defined a 4-tab layout —
**Audit · Reports · Backtest · Optimize** — labelled *"design only — engine not built"*.
These documents track turning that design into a working command surface.

| Phase | Scope | Status | Commits |
|---|---|---|---|
| [1](./phase-1-tabs-smart-prompt.md) | Tab shell · smart prompt · deterministic presets · Edu mode | ✅ shipped | `659d5bc` |
| [1.5](./phase-1.5-pills-chips.md) | Pill toggle · attach-to-prompt chips · auto-fill pills | ✅ shipped | `f222c4d` |
| [2](./phase-2-agent-reports.md) | send-to-Claude agent runs · Reports archive · model routing | ✅ shipped | `b449237` `c6ce861` `acb5d45` |
| [3](./phase-3-backtest.md) | Backtest tab (live Strategy Tester) | 📋 planned | — |
| [4](./phase-4-optimize.md) | Optimize tab · What-if panel · multi-symbol compare | 📋 planned | — |

Related: user manual [`../VIEWER_GUIDE.ko.md`](../VIEWER_GUIDE.ko.md) ·
outstanding side-deliverable: `docs/PROMPT_CATALOGUE.md` (planned in the v2 master plan, not yet written).

## Standing constraints (apply to every phase)

- Branch `my-changes` only. **Never PR, never merge to `main`.**
- `scripts/viewer/gate-audit.html` stays a single file: vanilla JS, inline CSS, canvas,
  **no build step, no external dependencies** (test-enforced self-containment; size ceiling
  raised deliberately per phase, currently 48 KB).
- The bridge (`scripts/http-bridge.js`) is the only network path; `POST /call` is a generic
  MCP tool proxy — new deterministic commands need no bridge changes.
- Palette and layout follow the recovered artboards (`#1a1a19` bg, `#7aa2f7` accent, mono type).
