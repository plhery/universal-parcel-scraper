import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { awsWafAction } from '../../core/transport/awsWaf.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { NEXT_SMART_SHIP_MAX_BYTES, normalizeNextSmartShipNumber, parseNextSmartShip, PROVIDER } from './parser.js';

export { normalizeNextSmartShipNumber, parseNextSmartShip } from './parser.js';

/** The lookup the tracker page at fulfillship.nextsmartship.com/track makes, with the numbers in a JSON list. */
export const NEXT_SMART_SHIP_LOOKUP = 'https://api.nextsmartship.com/oms/v3/tracks/v2/query';
const REDIRECTS = [301, 302, 303, 307, 308];
// AWS WAF's script and picture checks answer with these, and CloudFront serves the API.
const WAF_STATUSES = [202, 405];
// Bot checks a proxy in front of the service could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|gokuProps|awsWafCookieDomainList|<title>\s*(?:Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 15_000;

export class NextSmartShipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(NEXT_SMART_SHIP_LOOKUP, { method: 'POST', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      body: JSON.stringify({ search: [number] }),
    }, { provider: PROVIDER, timeoutMs, maxBytes: NEXT_SMART_SHIP_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...WAF_STATUSES] });
    if (awsWafAction(response.headers)) throw new ChallengeError(PROVIDER, 'Next Smart Ship answered with a browser check');
    // A redirect is a moved service, not a missing parcel: the tracker answers every number with HTTP 200.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Next Smart Ship tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Next Smart Ship answered with a browser check');
      throw new SchemaError(PROVIDER, 'Next Smart Ship answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Next Smart Ship returned a reply that is not JSON', { cause: error });
    }
    return parseNextSmartShip(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNextSmartShipNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NextSmartShipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
