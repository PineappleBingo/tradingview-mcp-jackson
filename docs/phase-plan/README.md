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
| [3](./phase-3-backtest.md) | Backtest tab — `RunConfig`/`RunCard`, tester settle detection, normalized metrics, validation (IS/OOS · walk-forward · Monte-Carlo), `POST /reports` | ✅ shipped · verified live 2026-09-04 | `c64f82f` `086f606` `692b723` + live fixes |
| [3.5](./phase-3.5-bias-checks.md) | Bias checks — repaint/lookahead via replay, history sensitivity | 📋 optional | — |
| [4](./phase-4-optimize.md) | Optimize tab — typed parameter space, objective registry, resumable bridge sweep job, verdict + decision log (4b What-if · 4c multi-symbol still planned) | ✅ shipped · verified live 2026-09-04 | `6fa737f` `777521a` `389e4ae` `ff282e0` + live fixes |

**Redesign 2026-09-03** (Phase 3/4 reviewed against the code and against ten open-source
trading repos): [what changed, how and why](./phase-3-4-redesign-notes.ko.md) ·
[which pattern came from which repo, and what was left out](./functional-spec-sources.ko.md).

**Live verification 2026-09-04**: the first run against a real Strategy Tester found three
blocking defects (the strategy locate idiom matched any study, an `indicator()` script has no
tester at all, and TradingView's percentages are fractions) plus two more in the decision log and
`ui_open_panel`. All fixed and re-verified end to end — see
[§7 of the implementation notes](./phase-3-4-implementation-notes.ko.md) and
[Phase 3 · Open questions answered live](./phase-3-backtest.md).

**Implementation 2026-09-03** (Phase 3 + 4 code, no live chart in the session): [what was built, how it works, what differs from the specs](./phase-3-4-implementation-notes.ko.md) · [functional spec of the implementation: file ← source, why, what, and what was not ported](./functional-spec-implementation.ko.md).

**Interactive flow diagrams** (self-contained HTML — pan, zoom, search, trace, guided views):
[run one backtest](../flows/backtest-flow.html) · [sweep and decide](../flows/optimize-flow.html) ·
walkthrough in [`../BACKTEST_OPTIMIZE_GUIDE.md`](../BACKTEST_OPTIMIZE_GUIDE.md).

Related: user manual [`../VIEWER_GUIDE.ko.md`](../VIEWER_GUIDE.ko.md) ·
outstanding side-deliverable: `docs/PROMPT_CATALOGUE.md` (planned in the v2 master plan, not yet written).

## Standing constraints (apply to every phase)

- Branch `my-changes` only. **Never PR, never merge to `main`.**
- `scripts/viewer/gate-audit.html` stays a single file: vanilla JS, inline CSS, canvas,
  **no build step, no external dependencies** (test-enforced self-containment; size ceiling
  raised deliberately per phase — now 100 KB at `tests/http_bridge.test.js` after Phase 4; the file
  sits at ~100.4 KB, so the next feature needs the next deliberate bump).
- The bridge (`scripts/http-bridge.js`) is the only network path; `POST /call` is a generic
  MCP tool proxy — new deterministic commands need no bridge changes. Anything that runs for
  minutes (agent runs, parameter sweeps) is a bridge **job** with status/cancel/resume
  (`/agent`, `/sweep`), never a single `/call`.
- TradingView's live Strategy Tester is the **only** backtest engine. Phase 3/4 add a
  validation layer around it; no simulator is written (canvas note, 2026-08-28).
- Palette and layout follow the recovered artboards (`#1a1a19` bg, `#7aa2f7` accent, mono type).
