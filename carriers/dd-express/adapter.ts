import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DD_EXPRESS_MAX_BYTES, normalizeDdExpressNumber, parseDdExpress, PROVIDER } from './parser.js';

export { ddExpressParcels, normalizeDdExpressNumber, parseDdExpress } from './parser.js';

/**
 * The lookup the tracking page at tracking.dd.express/v2/ makes on its main host. The page's
 * Singapore, Thai and Indonesian hosts ask api-sg, api-thai and api-indo.dd.express instead.
 */
export const DD_EXPRESS_LOOKUP = 'https://trackapi.dd.express/corporate/tracking/query';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a proxy in front of the lookup could put in place of its reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const DEFAULT_BUDGET_MS = 15_000;

export class DdExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${DD_EXPRESS_LOOKUP}?tracking_ids=${encodeURIComponent(number)}`, { signal,
      headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: DD_EXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // A redirect or a missing route is a moved lookup, not a missing parcel: an unknown number gets HTTP 200 and no parcel.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'DD Express tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DD Express answered with a browser check');
      throw new SchemaError(PROVIDER, 'DD Express answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'DD Express returned a reply that is not JSON', { cause: error });
    }
    return parseDdExpress(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDdExpressNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DdExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
