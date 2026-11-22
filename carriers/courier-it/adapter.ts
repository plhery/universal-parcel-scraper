import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { lookUpPostNet, type PostNetLookupOptions } from '../postnet-za/adapter.js';

const PROVIDER = 'Courier IT';
// Waybills are a few letters and digits, such as a customer prefix and nine digits.
const WAYBILL = /^[A-Z]{2,5}\d{6,10}$/;
// Courier IT's lookup through PostNet takes a page and one answer, each a second or two.
const DEFAULT_BUDGET_MS = 20_000;

/** Courier IT's waybills: a few letters, then digits. */
export function normalizeCourierItNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (WAYBILL.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Courier IT tracks waybills of letters and digits');
}

/**
 * Courier IT's own tracker answers over its page's live connection. PostNet's
 * tracker, which sends parcels with Courier IT, asks Courier IT for a waybill
 * and shows its events, so the adapter asks it for Courier IT's network alone.
 */
export class CourierItTracker {
  constructor(private readonly options: PostNetLookupOptions & { recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCourierItNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session.
    const attempt = (signal: AbortSignal, timeoutMs: number) => lookUpPostNet(number, ['cit'], this.options, signal, timeoutMs);
    return runSteps({ carrier: 'courier-it', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CourierItTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'courier-it', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
