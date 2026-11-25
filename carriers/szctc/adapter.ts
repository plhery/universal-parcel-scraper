import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { CARRIER, normalizeSzctcNumber, parseSzctc, PROVIDER, SZCTC_MAX_BYTES } from './parser.js';

/** CTC Supply Chain's tenant of the rtb56 platform: the tracking page's JSONP lookup, which needs no slider. */
export const SZCTC_API = 'http://szctc.rtb56.com/webservice/Service.ashx';
/** The JSONP callback the adapter names. */
export const SZCTC_CALLBACK = 'szctcTrack';

/** The platform's request for one number. */
export function szctcLookupUrl(number: string): string {
  return rtb56LookupUrl(SZCTC_API, SZCTC_CALLBACK, number);
}

export class SzctcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSzctcNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token, slider or account, and no Referer: another tenant of the platform
      // answers null to a request with one.
      const { response, bytes } = await fetchBounded(szctcLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: SZCTC_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'CTC Supply Chain tracking lookup is unavailable', { status: response.status });
      return parseSzctc(rtb56Json(decodeText(bytes), SZCTC_CALLBACK, PROVIDER), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SzctcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSzctcNumber(number))),
  };
};
