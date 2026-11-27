import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { IBEROMAIL_MAX_BYTES, normalizeIberomailNumber, parseIberomail, PROVIDER } from './parser.js';

export { normalizeIberomailNumber, parseIberomail } from './parser.js';

/** The search behind the tracker that iberomail.com/track-trace/ frames, at iberomail.com/TrackAndTrace/. */
export const IBEROMAIL_LOOKUP = 'https://iberomail.com/TrackAndTrace/search.php';
// The tracker page's script sends this key with every search; it is the same for every visitor.
export const IBEROMAIL_CLIENT_KEY = 'f8e2a6ec86a5406eaeb42c8d19e09490'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a proxy in front of the service could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|captcha|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The search's address for a number, as the tracker page's script builds it. */
export const iberomailLookupUrl = (number: string): string =>
  `${IBEROMAIL_LOOKUP}?${new URLSearchParams({ keyword: number, lang: 'en' }).toString()}`;

export class IberomailTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(iberomailLookupUrl(number), { signal, headers: {
      Accept: 'application/json, text/plain, */*', 'X-Client-Key': IBEROMAIL_CLIENT_KEY, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: IBEROMAIL_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: REDIRECTS });
    // A redirect is a moved service, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Iberomail tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Iberomail answered with a browser check');
      throw new SchemaError(PROVIDER, 'Iberomail answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Iberomail returned a reply that is not JSON', { cause: error });
    }
    return parseIberomail(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIberomailNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IberomailTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
