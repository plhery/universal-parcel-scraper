import { BudgetExceededError } from '../errors/index.js';
import { normalizeCarrierResult, type CarrierResult } from '../result/index.js';
import { runSteps } from '../runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';
import type { AdapterRegistry, TrackingContext, TrackingInput } from './index.js';

/** One carrier lookup, leaving provider selection and scheduling to the consumer. */
export async function trackCarrier(carrier: string, input: TrackingInput, options: TrackingContext & {
  registry: AdapterRegistry;
  universal: UniversalTracker;
  recorder?: StepRecorder;
}): Promise<CarrierResult> {
  if (options.budgetMs !== undefined && Number.isNaN(options.budgetMs)) throw new TypeError('Lookup budget must be a number of milliseconds');
  // A budget already spent is a budget failure, whichever adapter would have been asked.
  if (options.budgetMs !== undefined && options.budgetMs <= 0) throw new BudgetExceededError(carrier, options.budgetMs);
  const registered = options.registry.for(carrier);
  if (registered) {
    const context = { signal: options.signal, budgetMs: options.budgetMs === undefined ? undefined : Math.min(60_000, options.budgetMs) };
    try {
      const result = registered.recordsSteps || registered.steps.length > 1
        ? await registered.track(input, ...(options.signal || options.budgetMs !== undefined ? [context] as const : []))
        : await runSteps({ carrier, budgetMs: options.budgetMs ?? 120_000, signal: options.signal,
          recorder: options.recorder ?? NOOP_RECORDER }, [{ id: registered.steps[0] ?? 'direct',
          run: ({ signal, remainingMs }) => registered.track(input, ...(options.signal || options.budgetMs !== undefined ? [{ signal, budgetMs: context.budgetMs === undefined ? undefined : Math.min(context.budgetMs, remainingMs) }] as const : [])) }]);
      return normalizeCarrierResult(result);
    } catch (error) {
      // A caller's cancellation is the caller's reason, not a carrier failure.
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
    }
  }
  if (options.registry.adapterIdFor(carrier) === 'universal') {
    return normalizeCarrierResult(await options.universal.fetch(input.number, input.postcode,
      { signal: options.signal, budgetMs: options.budgetMs }));
  }
  throw new RangeError(`No tracking adapter is registered for ${carrier}`);
}
