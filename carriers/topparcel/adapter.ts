import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTopparcelChallenge, normalizeTopparcelNumber, parseTopparcel, PROVIDER, TOPPARCEL_MAX_BYTES, topparcelFormToken } from './parser.js';

export { normalizeTopparcelNumber, parseTopparcel } from './parser.js';

/** The tracking form, which posts the number back to its own address. */
export const TOPPARCEL_TRACKER = 'https://topparcel.com/parcels/tracking';
const ORIGIN = 'https://topparcel.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class TopparcelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The form, then its post with the form's token, in one session of their own. */
  private async read(number: string, context: TrackingContext): Promise<CarrierResult> {
    const budget = lookupBudget(context, DEFAULT_BUDGET_MS, PROVIDER);
    const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
    const userAgent = userAgentOf(this.options.userAgent);
    const page = async (init: RequestInit) => {
      const { response, bytes } = await fetchBounded(TOPPARCEL_TRACKER, { ...init, signal: budget.signal }, {
        provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: TOPPARCEL_MAX_BYTES, redirect: 'manual', fetcher, allowHttpStatuses: [...REDIRECTS, 403],
      });
      const html = decodeText(bytes);
      if (response.status === 403 || isTopparcelChallenge(html)) throw new ChallengeError(PROVIDER, 'Topparcel requires verification', { status: response.status });
      // A redirect is a moved form or a lost session, not a missing parcel.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Topparcel tracking moved', { status: response.status });
      return html;
    };
    const token = topparcelFormToken(await page({ headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' } }));
    const html = await page({
      method: 'POST',
      body: new URLSearchParams({ TOPPARCEL_CSRF_TOKEN: token, 'Shipment[track]': number, track: 'track' }),
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml', Origin: ORIGIN, Referer: TOPPARCEL_TRACKER },
    });
    return parseTopparcel(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTopparcelNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, { signal, budgetMs: firstAttemptMs(remainingMs) }) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, { signal, budgetMs: remainingMs })),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TopparcelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
