import type { AdapterFactory } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { NUMARK_TENANT, normalizeNumarkPro, PROVIDER } from './parser.js';
import { fetchWbprotrk } from './wbprotrk.js';

export { normalizeNumarkPro, parseNumark } from './parser.js';

const DEFAULT_BUDGET_MS = 20_000;

export const adapter: AdapterFactory = (environment) => ({
  id: PROVIDER,
  recordsSteps: true,
  steps: ['direct', 'retry'],
  async track(input, context = {}) {
    const pro = normalizeNumarkPro(input.number);
    const read = (signal: AbortSignal, timeoutMs: number) => fetchWbprotrk(NUMARK_TENANT, pro, {
      signal, timeoutMs, fetcher: environment.fetcher, userAgent: environment.userAgent,
    });
    // A read that fails to reach the trace, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({
      carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: environment.recorder ?? NOOP_RECORDER,
    }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  },
});
