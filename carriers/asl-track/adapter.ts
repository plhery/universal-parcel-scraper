import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ASL_MAX_BYTES, normalizeAslNumber, parseAsl, PROVIDER } from './parser.js';

export { normalizeAslNumber, parseAsl } from './parser.js';

/** ASL Track's public tracking API, which its documentation gives for integrations. */
export const ASL_API = 'https://asltrack.com/api/v1/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// A challenge page from the host in front of the API instead of its reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|vercel-challenge|<title>\s*(?:Just a moment|Attention Required|Vercel Security Checkpoint)/i;

/** The API's address for one number. */
export const aslLookupUrl = (number: string): string => `${ASL_API}${encodeURIComponent(number)}`;

export class AslTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(aslLookupUrl(number), { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ASL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const body = decodeText(bytes);
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ASL Track answered with a browser challenge', { status: response.status });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ASL Track redirected its tracking API', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'ASL Track refused the lookup', { status: 403 });
    const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
    // An unknown number is a 404 with the API's JSON answer; a 404 page without it is a moved API.
    if (response.status === 410 || (response.status === 404 && !json)) {
      throw new TransportError(PROVIDER, 'ASL Track tracking API is unavailable', { status: response.status });
    }
    if (!json) throw new SchemaError(PROVIDER, 'ASL Track answered with a page instead of its tracking reply');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'ASL Track returned a reply that is not JSON', { cause: error });
    }
    if (response.status === 404 && (typeof payload !== 'object' || payload === null || (payload as { found?: unknown }).found !== false)) {
      throw new TransportError(PROVIDER, 'ASL Track tracking API is unavailable', { status: 404 });
    }
    return parseAsl(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAslNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AslTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
