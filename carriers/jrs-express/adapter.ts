import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JRS_MAX_BYTES, normalizeJrsReference, parseJrs, PROVIDER } from './parser.js';

export { normalizeJrsReference, parseJrs } from './parser.js';

/** JRS Express's site, whose tracking page asks the API below. */
export const JRS_ORIGIN = 'https://jrs-express.com';
/** The lookup the tracking page makes for the reference typed in, without a session or key. */
export const JRS_API = 'https://jrs-core-api.azurewebsites.net/api/Tracking/v1/track-airbill';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// A challenge page, which a host in front of the API could give instead of its reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

/** The API's address for one reference, as the page's script builds it. */
export const jrsLookupUrl = (reference: string): string => `${JRS_API}?${new URLSearchParams({ airbill: reference })}`;

export class JrsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(reference: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(jrsLookupUrl(reference), { signal, headers: {
      Accept: 'application/json', Origin: JRS_ORIGIN, Referer: `${JRS_ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JRS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const body = decodeText(bytes);
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JRS Express answered with a browser challenge', { status: response.status });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'JRS Express redirected its tracking API', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'JRS Express refused the lookup', { status: 403, reason: 'api_denied' });
    // The API answers an unknown reference with HTTP 200 and an empty list; a missing route is a moved API.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'JRS Express tracking API is unavailable', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'JRS Express answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'JRS Express returned a reply that is not JSON', { cause: error });
    }
    return parseJrs(payload, reference);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { reference } = normalizeJrsReference(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(reference, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(reference, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers JRS Express for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new JrsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
