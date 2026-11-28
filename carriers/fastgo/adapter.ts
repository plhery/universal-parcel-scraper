import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, FASTGO_MAX_BYTES, normalizeFastgoNumber, parseFastgo, PROVIDER } from './parser.js';

/** The tracking page, which asks the route API from the visitor's browser. */
export const FASTGO_PAGE = 'https://www.fastgo.com.au/WaybillQuery/';
/**
 * The route API's lookup for several waybills. It answers a waybill it does not hold by leaving
 * it out of the list; its one-waybill route answers that with an unknown error instead.
 */
export const FASTGO_ROUTES = 'https://api.fastgoexp.com/api/route/getRoutes';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent/i;

/** The form the tracking page posts: the waybills as an indexed `billIds` list. */
export function fastgoRoutesBody(number: string): string {
  return new URLSearchParams({ 'billIds[0]': number }).toString();
}

export class FastgoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeFastgoNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The number alone, with no session, token or account.
      const { response, bytes } = await fetchBounded(FASTGO_ROUTES, { method: 'POST', signal, body: fastgoRoutesBody(number), headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.fastgo.com.au', Referer: FASTGO_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: FASTGO_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(remainingMs)), redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410] });
      // A missing waybill is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Fastgo route lookup is unavailable', { status: response.status });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fastgo answered with a verification page', { cause });
        throw new SchemaError(PROVIDER, 'Fastgo answered with a page instead of its route JSON', { cause });
      }
      return parseFastgo(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FastgoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFastgoNumber(number))),
  };
};
