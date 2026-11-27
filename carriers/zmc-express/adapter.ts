import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isZmcNotFound, normalizeZmcNumber, parseZmc, PROVIDER, ZMC_MAX_BYTES } from './parser.js';

export { normalizeZmcNumber, parseZmc } from './parser.js';

/** The tracking page, whose pop-up form asks the lookup below. */
export const ZMC_PAGE = 'https://apps.zmc-iraq.com/tracking.php';
/** The lookup the page's form asks for one reference's rows. */
export const ZMC_LOOKUP = 'https://apps.zmc-iraq.com/getTrack1.php';
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha/i;
const DEFAULT_BUDGET_MS = 20_000;

/** Twenty letters and digits, as the page's script sends with each lookup; the lookup's answer is cached ten minutes by its address. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]).join('');
}

/** The lookup's address for one reference, with the page's `source` and a fresh `random`. */
export function zmcLookupUrl(number: string, random = randomToken()): string {
  return `${ZMC_LOOKUP}?${new URLSearchParams({ cusRef: number, source: 'system', random })}`;
}

export class ZmcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(zmcLookupUrl(number), { signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: ZMC_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZMC_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved lookup, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'ZMC Express tracking moved', { status: response.status });
    // The lookup labels its JSON as HTML, so the body says what it is.
    const body = decodeText(bytes);
    if (isZmcNotFound(body)) throw new NotFoundError(PROVIDER, 'ZMC Express has no shipment under this reference');
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ZMC Express answered with a browser check');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'ZMC Express returned a reply that is not JSON', { cause: error });
    }
    return parseZmc(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZmcNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZmcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
