import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, E24_MAX_BYTES, e24Json, e24Token, isE24Blocked, normalizeE24Number, parseE24, PROVIDER } from './parser.js';

export { normalizeE24Number, parseE24 } from './parser.js';

export const E24_ORIGIN = 'https://tracking-ca.fareye.co';
/**
 * The `encodedString` of the public search page of E24's tracker on FarEye, the same for every visitor; the
 * search refuses a number without one.
 */
export const E24_SEARCH_KEY = 'Qg8NNI2PxmSa3TWy2asu6u3MzTI0ThS54ELjfozEWy2Wvg=='; // gitleaks:allow
export const E24_SEARCH = `${E24_ORIGIN}/app/rest/get_universal_tracking_url`;
export const E24_STATUSES = `${E24_ORIGIN}/app/rest/get_last_mile_and_status_details`;
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** E24's public search page for a number, the page a person opens. */
export const e24SearchPage = (number: string) =>
  `${E24_ORIGIN}/universal-search?encodedString=${encodeURIComponent(E24_SEARCH_KEY)}&lang=en&param1=${encodeURIComponent(number)}`;

/** The search the page makes for a number, in English. */
export const e24SearchUrl = (number: string) =>
  `${E24_SEARCH}?encodedString=${encodeURIComponent(E24_SEARCH_KEY)}&param1=${encodeURIComponent(number)}&settingType=BASIC&language=en`;

/** The statuses of the parcel the page's token names, as the page asks them. */
export const e24StatusesUrl = (token: string) =>
  `${E24_STATUSES}?url=${encodeURIComponent(token)}&isReturn=false&isMultiShipment=false&universalTracking=true`;

export class E24Tracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, referer: string, signal: AbortSignal, deadline: number): Promise<{ status: number; body: string }> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: referer, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: E24_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 403) {
      throw new ChallengeError(PROVIDER, isE24Blocked(body) ? 'E24 answered with a browser check' : 'E24 refused the lookup', { status });
    }
    if (status === 503) {
      if (isE24Blocked(body)) throw new ChallengeError(PROVIDER, 'E24 answered with a browser check', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers a token it does not take with HTTP 400 and no body; the search gave the token.
    if (status === 400) throw new IndeterminateError(PROVIDER, 'E24 refused the lookup', { status });
    // A redirect, or a missing route, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'E24 tracking is unavailable', { status });
    if (!body.trim()) throw new SchemaError(PROVIDER, 'E24 returned an empty reply');
    return { status, body };
  }

  /** The search for the number, then the statuses of the first page it gives, as the tracking page opens it. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const search = await this.get(e24SearchUrl(number), e24SearchPage(number), signal, deadline);
    const token = e24Token(search.body);
    const statuses = await this.get(e24StatusesUrl(token), `${E24_ORIGIN}/universal-tracking?${token}`, signal, deadline);
    return parseE24(e24Json(statuses.body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeE24Number(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers E24 for its numbers, which share the shape of other hexadecimal ids.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new E24Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
