import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ARRIIVAL_MAX_BYTES, normalizeArriivalNumber, parseArriival, PROVIDER } from './parser.js';

export { normalizeArriivalNumber, parseArriival } from './parser.js';

/** The lookup the tracking page at arriival.com/tracking makes, with the number in the query and no body. */
export const ARRIIVAL_LOOKUP = 'https://uml.arriival.com/qmcs-u-api/order/getOrderTracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a proxy in front of the service could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 15_000;

export class ArriivalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${ARRIIVAL_LOOKUP}?no=${encodeURIComponent(number)}`, { method: 'POST', signal,
      headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: ARRIIVAL_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // A redirect or a missing route is a moved tracker, not a missing waybill: the tracker answers a number it does
    // not hold with HTTP 200 and its own code.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Arriival tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Arriival answered with a browser check');
      throw new SchemaError(PROVIDER, 'Arriival answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Arriival returned a reply that is not JSON', { cause: error });
    }
    return parseArriival(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeArriivalNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ArriivalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
