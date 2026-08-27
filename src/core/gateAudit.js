/**
 * Gate-audit decoder: turns getStudySeries() output into per-bar entry verdicts
 * ("why did the strategy (not) enter on bar X?") using a strategy profile from
 * profiles/*.json. Everything except loadProfile()/runGateAudit() is pure.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStudySeries } from './data.js';
import { getState as getChartState } from './chart.js';

const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');
export const DEFAULT_PROFILE = 'pf3g-vp';

export function loadProfile(nameOrPath = DEFAULT_PROFILE, profilesDir = PROFILES_DIR) {
  const name = nameOrPath || DEFAULT_PROFILE;
  const file = (path.isAbsolute(name) || name.endsWith('.json')) ? name : path.join(profilesDir, name + '.json');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new Error(`Gate-audit profile not found: "${name}" (looked for ${file})`); }
  return JSON.parse(text);
}

export function plotFilterFromProfile(profile) {
  return Object.values(profile.columns).join('|');
}

export const gateKey = (g) => g.code + g.side;

function sortedGates(profile) { return [...profile.gates].sort((a, b) => a.bit - b.bit); }
function gateMap(profile) { return Object.fromEntries(profile.gates.map((g) => [gateKey(g), g])); }

// Columns come back as "Study Title::Plot Title"; match on the plot part only.
export function resolveColumns(columns, profile) {
  const suffixes = columns.map((c) => { const i = c.indexOf('::'); return (i >= 0 ? c.slice(i + 2) : c).toLowerCase(); });
  const indexByRole = {};
  const missing = [];
  for (const [role, title] of Object.entries(profile.columns)) {
    const want = title.toLowerCase();
    let idx = suffixes.findIndex((s) => s === want);
    if (idx < 0) idx = suffixes.findIndex((s) => s.includes(want));
    if (idx < 0) missing.push(role); else indexByRole[role] = idx;
  }
  return { indexByRole, missing };
}

// Bit = 1 means that gate PASSED; a zero bit is the blocker.
export function decodeMask(mask, profile) {
  const gates = sortedGates(profile);
  const m = Number(mask);
  const bits = gates.map((g) => ((m >> g.bit) & 1) === 1);
  const failed = gates.filter((_, i) => !bits[i]).map(gateKey);
  return { bits, failed };
}

// hundreds = regime active, tens = structural evidence 0-3, ones = POC whipsaw (1 bull / 2 bear)
export function decodeRegime(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return null;
  const n = Math.round(Number(v));
  return { raw: n, active: n >= 100, evidence: Math.floor((n % 100) / 10), whipsaw: n % 10 };
}

// Outermost gate first (profile.blockerPriority); "confirmed" only when nothing else failed.
export function pickBlocker(sideFailed, profile) {
  if (!sideFailed || sideFailed.length === 0) return null;
  const byKey = gateMap(profile);
  const hard = sideFailed.filter((k) => byKey[k] && byKey[k].code !== 'Conf');
  const pool = hard.length ? hard : sideFailed;
  for (const code of profile.blockerPriority || []) {
    const hit = pool.find((k) => byKey[k] && byKey[k].code === code);
    if (hit) return hit;
  }
  return pool[0];
}

function toIso(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

export function decodeGateAudit(series, profile) {
  const columns = series?.columns || [];
  const rows = series?.rows || [];
  const { indexByRole, missing } = resolveColumns(columns, profile);
  for (const role of profile.required || ['mask']) {
    if (!(role in indexByRole)) {
      throw new Error(`Required column "${profile.columns[role]}" not found in series (${columns.length} columns: ${columns.slice(0, 6).join(', ')}${columns.length > 6 ? ', …' : ''})`);
    }
  }
  const byKey = gateMap(profile);
  const num = (row, role) => {
    const i = indexByRole[role];
    if (i == null) return null;
    const v = row[i];
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const metricsOf = (row) => ({
    er: num(row, 'er'),
    roomPct: num(row, 'roomPct'),
    reqPct: num(row, 'reqPct'),
    targetRoomAtr: num(row, 'targetRoomAtr'),
    regime: decodeRegime(num(row, 'regime')),
    macro: num(row, 'macro'),
    volGate: num(row, 'volGate'),
    dshapeState: num(row, 'dshapeState'),
    dshapeRotation: num(row, 'dshapeRotation'),
    supertrend: num(row, 'supertrend'),
  });

  const verdicts = [];
  const blockerHistogram = {};
  let patternBars = 0, fired = 0, blocked = 0, live = 0;

  rows.forEach((row, ri) => {
    const t = Number(row[0]);
    const mask = num(row, 'mask');
    const base = {
      t, iso: toIso(t), live: false, side: null, reason: 0, reasonName: null, fired: false, mask,
      failedGates: [], sideFailedGates: [], blocker: null, blockerCode: null,
      metrics: metricsOf(row), governingInputs: [],
    };
    if (mask == null) { verdicts.push(base); return; }
    base.failedGates = decodeMask(mask, profile).failed;

    const rL = num(row, 'reasonL') || 0, rS = num(row, 'reasonS') || 0;
    const fL = !!num(row, 'firedL'), fS = !!num(row, 'firedS');
    const sides = [];
    if (rL > 0 || fL) sides.push('L');
    if (rS > 0 || fS) sides.push('S');
    if (sides.length === 0) { verdicts.push(base); return; }
    patternBars++;
    const isLast = ri === rows.length - 1;

    const verdictFor = (side) => {
      const reason = side === 'L' ? rL : rS;
      const isFired = side === 'L' ? fL : fS;
      const sideFailedGates = base.failedGates.filter((k) => byKey[k] && byKey[k].side === side);
      const blocker = isFired ? null : pickBlocker(sideFailedGates, profile);
      const g = blocker ? byKey[blocker] : null;
      const blockerCode = g ? (g.blocker || null) : null;
      const isLive = isLast && !isFired && !!g && g.code === 'Conf';
      return {
        side, reason, reasonName: profile.reasons?.[String(reason)] || null, fired: isFired, live: isLive,
        sideFailedGates, blocker, blockerCode,
        governingInputs: blockerCode ? (profile.governingInputs?.[blockerCode] || []) : [],
      };
    };

    const primarySide = sides.length === 1 ? sides[0] : (fS && !fL ? 'S' : 'L');
    const prim = verdictFor(primarySide);
    Object.assign(base, prim, { side: sides.length === 2 ? 'LS' : primarySide });
    if (sides.length === 2) {
      const sec = verdictFor(primarySide === 'L' ? 'S' : 'L');
      base.secondary = { side: sec.side, reason: sec.reason, reasonName: sec.reasonName, fired: sec.fired, sideFailedGates: sec.sideFailedGates, blocker: sec.blocker, blockerCode: sec.blockerCode };
    }
    if (prim.fired) fired++;
    else if (prim.live) live++;
    else if (prim.blocker) { blocked++; blockerHistogram[prim.blocker] = (blockerHistogram[prim.blocker] || 0) + 1; }
    verdicts.push(base);
  });

  const gates = sortedGates(profile).map((g) => ({ ...g, key: gateKey(g) }));
  return {
    profile: { name: profile.name, gates, reasons: profile.reasons || {} },
    columns: { resolved: indexByRole, missing },
    verdicts,
    summary: {
      bars: rows.length, patternBars, fired, blocked, live, blockerHistogram,
      firstIso: rows.length ? toIso(rows[0][0]) : null,
      lastIso: rows.length ? toIso(rows[rows.length - 1][0]) : null,
      missingColumns: missing,
    },
  };
}

// Tool entry point. deps are injectable for tests (no CDP needed).
export async function runGateAudit({ study_filter, count, profile } = {}, deps = {}) {
  const d = { getStudySeries, getChartState, loadProfile, ...deps };
  const p = d.loadProfile(profile);
  const series = await d.getStudySeries({ study_filter: study_filter || p.studyFilter, plot_filter: plotFilterFromProfile(p), count: count || 200 });
  let chart = null;
  try {
    const st = await d.getChartState();
    if (st && (st.symbol || st.resolution)) chart = { symbol: st.symbol ?? null, resolution: st.resolution ?? null };
  } catch { chart = null; }
  const study = series.columns.length > 1 ? series.columns[1].split('::')[0] : null;
  return { success: true, study, chart, bar_count: series.bar_count ?? series.rows.length, ...decodeGateAudit(series, p) };
}
