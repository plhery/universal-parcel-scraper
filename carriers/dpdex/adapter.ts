import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { CARRIER, DPDEX_MAX_BYTES, normalizeDpdexNumber, parseDpdex, PROVIDER } from './parser.js';

/** The tracking page, which opens the parcel from its `track_number` parameter. */
export const DPDEX_PAGE = 'https://client.duopudaexpress.com/track_query.aspx';
/** The rtb56 platform's lookup on DpdEx's tenant, beside its tracking page. */
export const DPDEX_API = 'https://client.duopudaexpress.com/webservice/Service.ashx';
/** The JSONP callback the adapter names. */
export const DPDEX_CALLBACK = 'dpdexTrack';

/** The platform's request for one number. */
export function dpdexLookupUrl(number: string): string {
  return rtb56LookupUrl(DPDEX_API, DPDEX_CALLBACK, number);
}

export class DpdexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDpdexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token, account or CAPTCHA.
      const { response, bytes } = await fetchBounded(dpdexLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01',
        Referer: `${DPDEX_PAGE}?${new URLSearchParams({ track_number: number })}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: DPDEX_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'DpdEx tracking lookup is unavailable', { status: response.status });
      return parseDpdex(rtb56Json(decodeText(bytes), DPDEX_CALLBACK, PROVIDER), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDpdexNumber(number))),
  };
};
