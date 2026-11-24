import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CITYMAIL_LOOKUP, CITYMAIL_MAX_BYTES, CITYMAIL_ORIGIN, CITYMAIL_PAGE, cityMailToken, isCityMailBlocked, normalizeCityMailNumber, parseCityMail, PROVIDER,
} from './parser.js';

export { CITYMAIL_LOOKUP, CITYMAIL_PAGE, normalizeCityMailNumber, parseCityMail } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// Laravel's answer to a post whose session token it refuses.
const EXPIRED = 419;
const DEFAULT_BUDGET_MS = 15_000;

export class CityMailTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCityMailNumber(raw);
    // A read that fails to reach the tracker, or hangs, gets one more try in a new session: the
    // first gets half of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, { signal, budgetMs: firstAttemptMs(remainingMs) }) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, { signal, budgetMs: remainingMs })),
    ]);
  }

  /**
   * The tracking page, then the post its script makes, in one session of their own: the post
   * carries the page's token and the session's cookies, and says it comes from the script, as
   * jQuery does. Without that header the tracker answers an empty page.
   */
  private async read(number: string, context: TrackingContext): Promise<CarrierResult> {
    const budget = lookupBudget(context, DEFAULT_BUDGET_MS, PROVIDER);
    const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
    const userAgent = userAgentOf(this.options.userAgent);
    const request = async (url: string, init: RequestInit) => {
      const { response, bytes } = await fetchBounded(url, { ...init, signal: budget.signal }, {
        provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: CITYMAIL_MAX_BYTES, redirect: 'manual', fetcher,
        allowHttpStatuses: [...REDIRECTS, 403, EXPIRED],
      });
      const text = decodeText(bytes);
      if (response.status === 403 || isCityMailBlocked(text)) throw new ChallengeError(PROVIDER, 'CityMail requires verification', { status: response.status });
      if (response.status === EXPIRED) throw new ChallengeError(PROVIDER, "CityMail refused the page's session token", { status: EXPIRED });
      // A redirect is a moved tracker or a login, not a missing parcel.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'CityMail tracking moved', { status: response.status });
      return { text, type: response.headers.get('content-type') ?? '' };
    };

    const page = await request(CITYMAIL_PAGE, { headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' } });
    const reply = await request(CITYMAIL_LOOKUP, {
      method: 'POST',
      body: new URLSearchParams({ cn_no: number }),
      headers: {
        'User-Agent': userAgent, Accept: 'application/json, text/javascript, */*; q=0.01', Origin: CITYMAIL_ORIGIN, Referer: CITYMAIL_PAGE,
        'X-CSRF-TOKEN': cityMailToken(page.text), 'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!/^application\/json\b/i.test(reply.type)) throw new SchemaError(PROVIDER, 'CityMail answered with a page instead of its tracking reply');
    let payload: unknown;
    try {
      payload = JSON.parse(reply.text);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'CityMail returned a reply that is not JSON', { cause: error });
    }
    return parseCityMail(payload, number);
  }
}

// No recognition: no detection rule offers CityMail Pakistan for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CityMailTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
