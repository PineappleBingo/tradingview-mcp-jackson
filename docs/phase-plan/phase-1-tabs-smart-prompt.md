# Phase 1 — Tab shell, smart prompt, deterministic presets, Edu mode

**Status: ✅ shipped** — commit `659d5bc` (2026-08-31)

## Problem

The viewer displayed a live gate audit but accepted no commands; every analysis required
typing `/strategy-gate-debug {prompt}` in a terminal. The recovered design canvas specified
a 4-tab command surface that had never been built (0% implemented).

## What was built

### Tabs
- `Audit · Reports · Backtest · Optimize`, hash-routed (`#audit` default; deep links work).
- Each tab is a `<section hidden>`; `showTab(name, ctx)` merges `ctx` into a shared
  `viewState` so presets can move the user to another tab **carrying state**.
- Canvases measure 0 while hidden → Audit re-renders on return.

### Smart prompt bar
- Free-text input + preset chips + collapsible chat-style console (`say(who, text)`).
- `PRESETS` array is the single extension point — one entry per command.
- Phase-1 deterministic presets (pure `POST /call`, no model, no cost):
  `last 10 entries` (`data_get_trades`), `last 10 blocked` (filters already-polled verdicts,
  zero extra requests), `worst blocker` (filters the table + jumps to Audit).
- Agent presets rendered disabled until Phase 2; free text composed the
  `/strategy-gate-debug` command and copied it to the clipboard (honest fallback).

### Edu mode
- Header `edu` toggle, persisted in `localStorage('eduMode')`, `body.classList` driven.
- Inline `GLOSSARY` (~8 terms initially), `.term` spans get dotted underlines + reuse the
  existing `#tip` tooltip; per-tab `.edu-note` beginner paragraphs.

## Reused instead of rebuilt

`call()`, `setStatus()`, `banner()`, `prep()/geom()` canvas helpers, token flow,
`visibilitychange` polling pause, and the existing `:root` palette (byte-identical to the
artboard colors — no restyling of existing sections).

## Verification (as run)

- `node --check` on the extracted inline script; div/section/nav tag balance
- Every `$('#id')` in the JS resolves to a real element (the blank-page failure mode)
- `npm run test:unit` — viewer size guard deliberately raised 25→40 KB with an intent
  comment; self-containment assertions untouched
- Browser click-through confirmed by the user (no Chrome in the container at that time)
