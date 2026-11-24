import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EMIRATES_COURIER_MAX_BYTES, normalizeEmiratesCourierNumber, parseEmiratesCourier, PROVIDER } from './parser.js';

export { normalizeEmiratesCourierNumber, parseEmiratesCourier } from './parser.js';

/** The consumer API behind the tracking page on emiratescx.com. */
export const EMIRATES_COURIER_API = 'https://api.emiratescx.com/consumer/api/Tracking/v3/EcomTracking';
const SITE = 'https://www.emiratescx.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// A firewall's or bot check's page in place of the API's reply.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|The request is blocked/i;

/** The details the tracking-details page asks for one number, in English. */
export const emiratesCourierLookupUrl = (number: string): string => `${EMIRATES_COURIER_API}/${encodeURIComponent(number)}/en-US/view-details`;

export class EmiratesCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One read as the page makes it, from the site's origin, without a session or token. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(emiratesCourierLookupUrl(number), { signal, headers: {
      Accept: 'application/json', Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EMIRATES_COURIER_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const body = decodeText(bytes);
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Emirates Courier Express answered with a block page', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Emirates Courier Express refused the lookup', { status: 403 });
    // The API answers an unknown number with HTTP 200; a redirect or a missing route is a moved API.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Emirates Courier Express tracking API is unavailable', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'Emirates Courier Express answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Emirates Courier Express returned a reply that is not JSON', { cause: error });
    }
    return parseEmiratesCourier(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEmiratesCourierNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Emirates Courier Express for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new EmiratesCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
