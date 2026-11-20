import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePhantomNumber, parsePhantom, PHANTOM_MAX_BYTES, PROVIDER } from './parser.js';

/** The GraphQL endpoint of Courie, the dispatch platform whose guest portal Phantom's tracking page is. */
export const COURIE_API = 'https://api.courie.ai/graphql';
/** Phantom's account on Courie, which the portal reads from its path `phantom`. */
export const PHANTOM_COURIER_ID = 'COUR0PHANTOM8922';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare can put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details/i;

// The portal's own query, without the addresses, contacts, driver, proofs and price it also asks for.
const QUERY = `query shipmentByTrackingNumber($courierId: ID!, $trackingNumber: String!) {
  shipmentByTrackingNumber(courierId: $courierId, trackingNumber: $trackingNumber) {
    trackingNumber status completionReason holdStatus createdAt assignedAt
    stops { type city state completedAt completionReason tasks { sequenceNumber } }
  }
}`;

/** Phantom's tracking page for one order on Courie's guest portal. */
export function phantomTrackingUrl(number: string): string {
  return `https://portal.courie.ai/phantom/trackshipment?trackingNumber=${encodeURIComponent(number)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Courie answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Courie returned a reply that is not JSON', { cause });
  }
}

export class PhantomTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePhantomNumber(raw);
    const body = JSON.stringify({ operationName: 'shipmentByTrackingNumber',
      variables: { courierId: PHANTOM_COURIER_ID, trackingNumber: number }, query: QUERY });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(COURIE_API, { method: 'POST', signal, body, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PHANTOM_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429] });
      // An order the courier does not hold is HTTP 200 with an empty answer.
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Courie refused the tracking lookup');
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Courie redirected its tracking lookup');
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Courie tracking lookup is unavailable');
      return parsePhantom(json(decodeText(bytes)), number);
    };
    // A request that fails to reach Courie, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'phantom-couriers', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PhantomTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'phantom-couriers', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
