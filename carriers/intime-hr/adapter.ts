import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, IN_TIME_MAX_BYTES, normalizeInTimeNumber, parseInTime, PROVIDER } from './parser.js';

/** The tracking page, whose script asks the tracking API from the visitor's browser. */
export const IN_TIME_PAGE = 'https://www.in-time.hr/pracenje';
/** The site's tracking API, which the page asks with the number alone, without a session or key. */
export const IN_TIME_TRACKING = 'https://www.in-time.hr/api/track.php';
// Bot checks a CDN or a firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|Access denied/i;
/** A number the API does not hold is HTTP 404 with its JSON; 400 and 403 are read for an error or a verification page. */
const READ_STATUSES = [400, 403, 404];

export class InTimeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeInTimeNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const url = `${IN_TIME_TRACKING}?id=${encodeURIComponent(number)}`;
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', Referer: `${IN_TIME_PAGE}?id=${encodeURIComponent(number)}`,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: IN_TIME_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(remainingMs)), redirect: 'manual', allowHttpStatuses: READ_STATUSES });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'In Time answered with a verification page', { cause });
        if (response.status !== 200) throw new TransportError(PROVIDER, 'In Time tracking is unavailable', { status: response.status, cause });
        throw new SchemaError(PROVIDER, 'In Time answered with a page instead of its tracking JSON', { cause });
      }
      return parseInTime(payload, number, response.status);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new InTimeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
