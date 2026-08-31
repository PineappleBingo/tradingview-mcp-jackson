# Phase 1.5 — Pill toggle, attach-to-prompt chips, auto-fill pills

**Status: ✅ shipped** — commit `f222c4d` (2026-08-31)
Driven by first-use feedback: results appended forever, and there was no way to hand a
preset's data to the AI together with a typed prompt.

## Design

### Pill anatomy — one capsule, two hit areas

```
┌───────────────────────┬────┐
│  last 10 entries      │ ⊕ │    label click → toggle result panel (accent border while open)
└───────────────────────┴────┘    ⊕ click    → capture data NOW, attach as chip on the input
```

### Three pill kinds in one `PRESETS` array

| kind | label click | ⊕ |
|---|---|---|
| `js` (data) | toggle keyed console panel | attach data chip |
| `fill` (✎) | pre-type an editable prompt into `#ask` | — |
| `agent` | disabled until Phase 2 | — |

### Key decisions
- Data presets expose **one `text(): Promise<string>` renderer** shared by panel and chip,
  so the two can never drift.
- Attach captures the **data at attach time** — "what you saw is what the AI gets".
  Deliberate exception: the Pine source is never embedded (200 KB+); code-review prompts
  tell the agent to fetch it itself.
- `runPrompt()` composes `user text` + one `### context: <label>` block per chip.
  This exact string later became the `POST /agent` payload unchanged (no Phase-2 rework).
- Chips clear after a successful send; duplicate attach is a no-op; `×` removes.
- `worst blocker`'s side effect (filter table + jump) fires on panel-ON only.

### Auto-fill pills (5)
`analyze entries` · `verify entries` · `explain this bar` (needs a selected bar; says so) ·
`tune worst blocker` (pulls the live top blocker + its governing inputs) · `draft session report`.
Fill pills only type for you — you edit, then run.

## Verification (as run)

Toggle on/off with no duplicates; ⊕ → chip → × → re-attach; composed clipboard prompt
carries the context blocks; `explain this bar` with no selection gives guidance not an error;
34.7 KB (under the 40 KB guard); 78/78 tests; confirmed working in the user's browser
(the user's pasted console output was the acceptance evidence).
