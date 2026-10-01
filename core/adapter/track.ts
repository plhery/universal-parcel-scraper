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
  const registered = options.registry.for(carrier);
  if (registered) {
    const context = { signal: options.signal, budgetMs: options.budgetMs === undefined ? undefined : Math.min(60_000, options.budgetMs) };
    const result = registered.recordsSteps || registered.steps.length > 1
      ? await registered.track(input, ...(options.signal || options.budgetMs !== undefined ? [context] as const : []))
      : await runSteps({ carrier, budgetMs: options.budgetMs ?? 120_000, signal: options.signal,
        recorder: options.recorder ?? NOOP_RECORDER }, [{ id: registered.steps[0] ?? 'direct',
        run: ({ signal, remainingMs }) => registered.track(input, ...(options.signal || options.budgetMs !== undefined ? [{ signal, budgetMs: context.budgetMs === undefined ? undefined : Math.min(context.budgetMs, remainingMs) }] as const : [])) }]);
    return normalizeCarrierResult(result);
  }
  if (options.registry.adapterIdFor(carrier) === 'universal') {
    return normalizeCarrierResult(await options.universal.fetch(input.number, input.postcode));
  }
  throw new RangeError(`No tracking adapter is registered for ${carrier}`);
}
