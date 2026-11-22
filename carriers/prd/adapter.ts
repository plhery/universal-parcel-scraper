import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { normalizePrdNumber, parsePrd, PRD_MAX_BYTES, PROVIDER } from './parser.js';

/** The tracking page Prime Express's site links to, on its tenant of the rtb56 platform. */
export const PRD_PAGE = 'https://szprd.rtb56.com/track_query.aspx';
/** The tenant's lookup, which answers without a cookie or account. */
export const PRD_API = 'https://szprd.rtb56.com/webservice/Service.ashx';
/** The JSONP callback the adapter names. */
export const PRD_CALLBACK = 'prdTrack';

/** The platform's request for one number. */
export function prdLookupUrl(number: string): string {
  return rtb56LookupUrl(PRD_API, PRD_CALLBACK, number);
}

export class PrdTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePrdNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(prdLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01', Referer: PRD_PAGE,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PRD_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // The lookup answers every number with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Prime Express tracking lookup moved', { status: response.status });
      return parsePrd(rtb56Json(decodeText(bytes), PRD_CALLBACK, PROVIDER), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'prd', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PrdTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'prd', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePrdNumber(number))),
  };
};
