import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSendyNumber, parseSendy, PROVIDER, SENDY_MAX_BYTES, SENDY_NO_UPDATE, sendyErrorKey } from './parser.js';

export { normalizeSendyNumber, parseSendy } from './parser.js';

/** The lookup the tracking page at www.sendy.com.my/en/track makes, with the number as a path segment. */
export const SENDY_LOOKUP = 'https://www.sendy.com.my/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the site, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 15_000;

export class SendyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // HTTP 429 is the tracker's rate limit and 403 Cloudflare's refusal, which the shared HTTP error reads as such.
    const { response, bytes } = await fetchBounded(`${SENDY_LOOKUP}${encodeURIComponent(number)}?lang=en`, { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: SENDY_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410, 422] });
    // A redirect or a missing route is a moved tracker, not a missing parcel.
    if (response.status !== 200 && response.status !== 422) {
      throw new TransportError(PROVIDER, 'Sendy tracking moved', { status: response.status });
    }
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sendy answered with a browser check');
      throw new SchemaError(PROVIDER, 'Sendy answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Sendy returned a reply that is not JSON', { cause: error });
    }
    if (response.status === 422) {
      // The tracker's answer for a number it holds nothing under, which its page words "The tracking information has
      // not been updated". Any other refusal says nothing about the parcel.
      const key = sendyErrorKey(payload);
      if (key === SENDY_NO_UPDATE) throw new NotFoundError(PROVIDER, 'Sendy has no tracking information under this number');
      throw new IndeterminateError(PROVIDER, 'Sendy refused the lookup', { status: 422, ...(key ? { reason: key } : {}) });
    }
    return parseSendy(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSendyNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SendyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
