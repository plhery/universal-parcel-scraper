import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COMMERCIVE_MAX_BYTES, normalizeCommerciveNumber, parseCommercive, PROVIDER } from './parser.js';

export { normalizeCommerciveNumber, parseCommercive } from './parser.js';

/** The lookup the tracker on commerciveparcel.com makes for the numbers typed in. */
export const COMMERCIVE_API = 'https://commerciveparcel.com/api/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// A challenge page, which can come from the host in front of the API instead of its reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|vercel-challenge|<title>\s*(?:Just a moment|Attention Required|Vercel Security Checkpoint)/i;

/** The API's address for one number, as the page's script builds it. */
export const commerciveLookupUrl = (number: string): string => `${COMMERCIVE_API}?${new URLSearchParams({ numbers: number })}`;

export class CommerciveTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(commerciveLookupUrl(number), { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COMMERCIVE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const body = decodeText(bytes);
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Commercive Parcel answered with a browser challenge', { status: response.status });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Commercive Parcel redirected its tracking API', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Commercive Parcel refused the lookup', { status: 403 });
    // The tracker answers an unknown number with HTTP 200; a missing route is a moved API.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Commercive Parcel tracking API is unavailable', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'Commercive Parcel answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Commercive Parcel returned a reply that is not JSON', { cause: error });
    }
    return parseCommercive(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCommerciveNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CommerciveTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
