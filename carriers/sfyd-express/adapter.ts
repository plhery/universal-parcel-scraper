import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { CARRIER, normalizeSfydNumber, parseSfyd, PROVIDER, SFYD_MAX_BYTES } from './parser.js';

/** The tracking page, which opens the parcel from its `c` parameter. */
export const SFYD_PAGE = 'https://sfydexpress.com/tracking.html';
/** SFYD's tenant of the rtb56 platform, whose lookup the tracking page's own service relays; it answers plain HTTP only. */
export const SFYD_API = 'http://sfyd.rtb56.com/webservice/Service.ashx';
/** The JSONP callback the adapter names. */
export const SFYD_CALLBACK = 'sfydTrack';

/** The platform's request for one number. */
export function sfydLookupUrl(number: string): string {
  return rtb56LookupUrl(SFYD_API, SFYD_CALLBACK, number);
}

export class SfydTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSfydNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token or account.
      const { response, bytes } = await fetchBounded(sfydLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01',
        Referer: `${SFYD_PAGE}?${new URLSearchParams({ c: number })}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: SFYD_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SFYD Express tracking lookup is unavailable', { status: response.status });
      return parseSfyd(rtb56Json(decodeText(bytes), SFYD_CALLBACK, PROVIDER), number);
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
  const tracker = new SfydTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSfydNumber(number))),
  };
};
