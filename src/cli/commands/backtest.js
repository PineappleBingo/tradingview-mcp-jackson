import { register } from '../router.js';
import { runBacktest } from '../../core/backtest.js';

register('backtest', {
  description: 'Backtest tools (run one reproducible backtest on the live Strategy Tester)',
  subcommands: new Map([
    ['run', {
      description: 'Apply optional input overrides, wait for the tester to settle, return a RunCard',
      options: {
        inputs: { type: 'string', short: 'i', description: 'JSON input overrides, e.g. \'{"in_12": "Hard Filter"}\'' },
        split: { type: 'string', short: 's', description: 'ISO split date for in-sample / out-of-sample' },
        study: { type: 'string', description: 'Strategy study name substring (default PineForge|PF 3G)' },
        restore: { type: 'boolean', short: 'r', description: 'Restore original inputs after reading' },
        timeout: { type: 'string', short: 't', description: 'Settle timeout in ms (default 15000)' },
        capital: { type: 'string', short: 'c', description: 'Initial capital for percent metrics' },
        md: { type: 'boolean', description: 'Return only the markdown body' },
      },
      handler: async (opts) => {
        const c = {};
        if (opts.inputs) c.inputs = JSON.parse(opts.inputs);
        if (opts.split) c.splitDate = opts.split;
        if (opts.study) c.study = { name: opts.study };
        if (opts.restore) c.restore = true;
        if (opts.timeout) c.settle = { timeoutMs: Number(opts.timeout) };
        if (opts.capital) c.costs = { initialCapital: Number(opts.capital) };
        const r = await runBacktest(c);
        return opts.md && r.success ? { success: true, body_md: r.card.body_md } : r;
      },
    }],
  ]),
});
