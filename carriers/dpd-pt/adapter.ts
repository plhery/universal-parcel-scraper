import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPD_PT_MAX_BYTES, normalizeDpdPtNumber, parseDpdPt, PROVIDER } from './parser.js';

/** DPD Portugal's tracker; its search form sends the browser to this address with the reference. */
export const DPD_PT_TRACKER = 'https://tracking.dpd.pt/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown reference itself: a missing page is not a missing parcel.
const GONE = [404, 410];

/** The tracker's page for one reference, in Portuguese. */
export function dpdPtLookupUrl(number: string): string {
  return `${DPD_PT_TRACKER}?${new URLSearchParams({ reference: number })}`;
}

export class DpdPtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDpdPtNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(dpdPtLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DPD_PT_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'DPD Portugal redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new IndeterminateError(PROVIDER, 'DPD Portugal tracking page is unavailable', { status: response.status });
      return parseDpdPt(decodeText(bytes), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dpd-pt', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdPtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dpd-pt', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDpdPtNumber(number))),
  };
};
