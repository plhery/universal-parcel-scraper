import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  assertNotChallenged, BLUEGRACE_MAX_BYTES, BLUEGRACE_PAGE_MAX_BYTES, normalizeBluegraceNumber, parseBluegrace, parseBluegraceNonce, PROVIDER,
  type BluegraceReference,
} from './parser.js';

/** The tracking page, whose script looks the number up with a nonce. */
export const BLUEGRACE_PAGE = 'https://mybluegrace.com/track/';
/** The WordPress endpoint that script asks. */
export const BLUEGRACE_API = 'https://mybluegrace.com/wp-admin/admin-ajax.php';
/** The tracking plugin's action. */
export const BLUEGRACE_ACTION = 'bluegrace_shipment_search';
const REDIRECTS = [301, 302, 303, 307, 308];
// WordPress's answer to a nonce it does not accept.
const NONCE_REFUSED = '-1';

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    assertNotChallenged(body);
    throw new SchemaError(PROVIDER, 'BlueGrace returned a reply that is not JSON', { cause });
  }
}

export class BluegraceTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBluegraceNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const options = (maxBytes: number, allowed: readonly number[]) => ({ provider: PROVIDER, maxBytes, redirect: 'manual' as const,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...allowed] });
      const userAgent = userAgentOf(this.options.userAgent);
      // The page carries the nonce its lookup needs. The site's caches keep
      // copies of the page whose nonce WordPress no longer accepts, so it is
      // read fresh, at an address no cache holds, for every lookup.
      const page = await fetchBounded(`${BLUEGRACE_PAGE}?${new URLSearchParams({ _: String(Date.now()) })}`, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': userAgent,
      } }, options(BLUEGRACE_PAGE_MAX_BYTES, [404, 410]));
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'BlueGrace’s tracking page is unavailable');
      const nonce = parseBluegraceNonce(decodeText(page.bytes));
      const lookup = async (reference: BluegraceReference): Promise<unknown> => {
        const query = new URLSearchParams({ action: BLUEGRACE_ACTION, nonce, refName: reference, refValue: number });
        const { response, bytes } = await fetchBounded(`${BLUEGRACE_API}?${query}`, { method: 'GET', signal, headers: {
          Accept: 'application/json, text/javascript, */*', 'User-Agent': userAgent,
        } }, options(BLUEGRACE_MAX_BYTES, [400, 403, 404, 410]));
        const body = decodeText(bytes);
        if (response.status === 403) {
          // WordPress refuses a nonce with HTTP 403 and `-1`; Cloudflare's checks come with 403 too.
          if (body.trim() === NONCE_REFUSED) throw new SchemaError(PROVIDER, 'BlueGrace refused the nonce its tracking page gave');
          if (response.headers.get('cf-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'BlueGrace requires browser verification', { status: 403 });
          assertNotChallenged(body);
          throw new ChallengeError(PROVIDER, 'BlueGrace refused the lookup', { status: 403 });
        }
        // WordPress answers an action no plugin registers with HTTP 400 and `0`; a 404 is a moved route.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'BlueGrace’s tracking lookup is unavailable');
        return json(body);
      };
      // The page looks a number up as the bill of lading or the PRO number
      // its visitor picks. A bill of lading the tracker does not know may be
      // a carrier's PRO number, so that is asked next with the same nonce.
      const bol = await lookup('BOL');
      if (!Array.isArray(bol) || bol.length) return parseBluegrace(bol, number, 'BOL');
      try {
        return parseBluegrace(await lookup('PRO'), number, 'PRO');
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundError(PROVIDER, 'BlueGrace has no shipment under this bill of lading or PRO number');
        throw error;
      }
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bluegrace-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BluegraceTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bluegrace-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
