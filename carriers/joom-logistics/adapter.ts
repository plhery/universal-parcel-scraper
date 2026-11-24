import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isJoomLogisticsNotFound, JOOM_LOGISTICS_MAX_BYTES, normalizeJoomLogisticsNumber, parseJoomLogistics, PROVIDER } from './parser.js';

export { normalizeJoomLogisticsNumber, parseJoomLogistics } from './parser.js';

/** The interface the tracker at joomlogistics.com asks, its `MAIN_API`. */
export const JOOM_LOGISTICS_API = 'https://api-logistics.joom.com/api/0.1/trackings';
const JOOM_LOGISTICS_PAGE = 'https://joomlogistics.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|captcha|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

/** The address the page's script asks for a number, in English as the page's English version does. */
export const joomLogisticsLookupUrl = (number: string): string =>
  `${JOOM_LOGISTICS_API}?trackingNumber=${encodeURIComponent(number)}&lang=en`;

function json(body: string, contentType: string): unknown {
  if (/^application\/json\b/i.test(contentType)) {
    try {
      return JSON.parse(body);
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'Joom Logistics returned a reply that is not JSON', { cause });
    }
  }
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Joom Logistics answered with a browser check');
  throw new SchemaError(PROVIDER, 'Joom Logistics answered with a page instead of its tracking reply');
}

export class JoomLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(joomLogisticsLookupUrl(number), { signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: JOOM_LOGISTICS_PAGE.slice(0, -1),
      Referer: JOOM_LOGISTICS_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JOOM_LOGISTICS_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Joom Logistics moved its tracking interface', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Joom Logistics refused the lookup', { status: 403 });
    const body = json(decodeText(bytes), response.headers.get('content-type') ?? '');
    if (response.status === 404) {
      // Only the interface's own answer naming the number says it is unknown; another 404 is a moved route.
      if (isJoomLogisticsNotFound(body, number)) throw new NotFoundError(PROVIDER, 'Joom Logistics has no parcel under this number');
      throw new SchemaError(PROVIDER, 'Joom Logistics answered 404 without its not-found reply', { status: 404 });
    }
    return parseJoomLogistics(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJoomLogisticsNumber(raw);
    // A read that fails to reach the interface, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: 'joom-logistics', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JoomLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'joom-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
