/**
 * Phase 4 — objective registry. Every objective is SMALLER-IS-BETTER over a RunCard's
 * normalized metrics (freqtrade's hyperopt_loss_function contract), so samplers, ranking and
 * the matrix never special-case a direction. Formulas are re-implemented from freqtrade's
 * published loss classes (GPLv3 — no code copied); the trade-count target is 30 instead of 50.
 */
import { tradeCountPenalty } from './validate.js';

export const DRAWDOWN_MULT = 0.075;
export const TARGET_TRADES = 30;
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

function profitDraw(m) {
  const net = num(m.netProfit); if (net == null) return null;
  const relDD = (num(m.maxDrawdownPct) ?? 0) / 100;
  return net - relDD * net * (1 - DRAWDOWN_MULT);
}
function pfOf(m) {
  const pf = num(m.profitFactor);
  if (pf != null) return pf;
  const gp = num(m.grossProfit), gl = num(m.grossLoss);
  if (gp != null && gl != null) return gl === 0 ? (gp > 0 ? 10 : null) : gp / Math.abs(gl);
  return null;
}

export const OBJECTIVES = {
  only_profit: { label: 'net profit', desc: 'Total net profit only (freqtrade OnlyProfitHyperOptLoss)', fn: (m) => { const v = num(m.netProfit); return v == null ? null : -v; } },
  profit_factor: { label: 'profit factor', desc: 'Profit factor capped at 10', fn: (m) => { const pf = pfOf(m); return pf == null ? null : -Math.min(pf, 10); } },
  sharpe: { label: 'Sharpe', desc: 'Trade-based annualised Sharpe (SharpeHyperOptLoss)', fn: (m) => { const v = num(m.sharpe); return v == null ? null : -v; } },
  sortino: { label: 'Sortino', desc: 'Downside-deviation Sharpe (SortinoHyperOptLoss)', fn: (m) => { const v = num(m.sortino); return v == null ? null : -v; } },
  calmar: { label: 'Calmar', desc: 'Annualised return / max drawdown % (CalmarHyperOptLoss)', fn: (m) => { const v = num(m.calmar); return v == null ? null : -v; } },
  max_drawdown_ratio: { label: 'profit / drawdown', desc: '−net profit / max drawdown (MaxDrawDownHyperOptLoss)', fn: (m) => { const net = num(m.netProfit), dd = num(m.maxDrawdown); if (net == null) return null; return dd > 0 ? -net / dd : -net; } },
  profit_drawdown: { label: 'profit − drawdown', desc: '−(net − relDD·net·(1−0.075)) (ProfitDrawDownHyperOptLoss)', fn: (m) => { const v = profitDraw(m); return v == null ? null : -v; } },
  multi_metric: { label: 'multi-metric', desc: 'profit-drawdown × ln(PF+1) × ln(min(10,ER)+2) × ln(1.2+winRate) × trade-count penalty (MultiMetricHyperOptLoss, target 30 trades)',
    fn: (m) => {
      const pd = profitDraw(m); if (pd == null) return null;
      const pf = pfOf(m) ?? 0, er = num(m.expectancyRatio) ?? 0, wr = (num(m.winRate) ?? 0) / 100, n = num(m.totalTrades) ?? 0;
      const v = pd * Math.log(Math.max(0, pf) + 1) * Math.log(Math.min(10, Math.max(0, er)) + 2) * Math.log(1.2 + Math.max(0, Math.min(1, wr))) * tradeCountPenalty(n, { target: TARGET_TRADES });
      return Number.isFinite(v) ? -v : null;
    } },
};
export const DEFAULT_OBJECTIVE = 'multi_metric';

export function list() { return Object.entries(OBJECTIVES).map(([name, o]) => ({ name, label: o.label, desc: o.desc, default: name === DEFAULT_OBJECTIVE })); }

/** Smaller is better; null ranks last. */
export function score(name, metrics) {
  const o = OBJECTIVES[name];
  if (!o) throw new Error('unknown objective ' + name + ' (known: ' + Object.keys(OBJECTIVES).join(', ') + ')');
  if (!metrics || typeof metrics !== 'object') return null;
  const v = o.fn(metrics);
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
}
