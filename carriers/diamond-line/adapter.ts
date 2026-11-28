import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, DIAMOND_LINE_MAX_BYTES, normalizeDiamondLineNumber, parseDiamondLine, PROVIDER } from './parser.js';

/** The tracking page, whose widget asks the tracking API from the visitor's browser. */
export const DIAMOND_LINE_PAGE = 'https://www.dlds.com/manage/track-shipment/';
/** The site's tracking API, which the widget posts the PRO number to as JSON, without cookies or a nonce. */
export const DIAMOND_LINE_TRACKING = 'https://www.dlds.com/wp-json/dlds/v1/tracking';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|Access denied/i;
/**
 * The API answers a shipment with HTTP 500 and its JSON, and a number it does not hold with HTTP
 * 404 and WordPress's error object; both are read. A 403 or 503 is read for a verification page.
 */
const READ_STATUSES = [403, 404, 500, 503];

export class DiamondLineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDiamondLineNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The number alone, with no session, nonce or account.
      const { response, bytes } = await fetchBounded(DIAMOND_LINE_TRACKING, { method: 'POST', signal,
        body: JSON.stringify({ type: 'pro', number }), headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://www.dlds.com',
          Referer: DIAMOND_LINE_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: DIAMOND_LINE_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(remainingMs)), redirect: 'manual', allowHttpStatuses: READ_STATUSES });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Diamond Line answered with a verification page', { cause });
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Diamond Line tracking is unavailable', { status: response.status, cause });
        throw new SchemaError(PROVIDER, 'Diamond Line answered with a page instead of its tracking JSON', { cause });
      }
      return parseDiamondLine(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DiamondLineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
