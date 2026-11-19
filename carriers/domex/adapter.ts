import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DOMEX_MAX_BYTES, normalizeDomexNumber, parseDomex, PROVIDER } from './parser.js';

/** The guest JSON request published by the Domex result page. */
export const DOMEX_TRACKING = 'https://domex.lk/track.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route says nothing about the waybill.
const GONE = [404, 410];

/** The page's address for one whole waybill number. */
export function domexTrackingUrl(number: string): string {
  return `${DOMEX_TRACKING}?${new URLSearchParams({ ajax: '1', trackingNo: normalizeDomexNumber(number) })}`;
}

export class DomexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDomexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(domexTrackingUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DOMEX_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Domex redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Domex tracking page is unavailable', { status: response.status });
      return parseDomex(decodeText(bytes), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'domex', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DomexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'domex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDomexNumber(number))),
  };
};
