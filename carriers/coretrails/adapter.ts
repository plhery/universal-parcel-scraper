import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CORETRAILS_MAX_BYTES, normalizeCoretrailsNumber, parseCoretrails, PROVIDER } from './parser.js';

export { normalizeCoretrailsNumber, parseCoretrails } from './parser.js';

/** The service the tracking page on www.coretrails.com asks for a number. */
export const CORETRAILS_API = 'https://coretrails-production-80157501098.us-east4.run.app/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// Bot checks a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|<title>\s*Access denied/i;

export class CoretrailsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${CORETRAILS_API}?tracking_number=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CORETRAILS_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404] });
    const body = decodeText(bytes);
    const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
    if (response.status === 403 || (!json && CHALLENGE.test(body.slice(0, 64_000)))) {
      throw new ChallengeError(PROVIDER, 'Coretrails answered with a browser check');
    }
    // The service answers a number it has no shipment under with an empty 404; an unknown route is a 500.
    if (response.status === 404 && !body.trim()) throw new NotFoundError(PROVIDER, 'Coretrails has no shipment under this number');
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Coretrails tracking moved', { status: response.status });
    if (!json) throw new SchemaError(PROVIDER, 'Coretrails answered with a page instead of its tracking reply');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Coretrails returned a reply that is not JSON', { cause: error });
    }
    return parseCoretrails(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCoretrailsNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CoretrailsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
