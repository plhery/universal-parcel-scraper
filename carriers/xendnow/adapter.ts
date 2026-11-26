import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeXendnowNumber, parseXendnow, PROVIDER, XENDNOW_MAX_BYTES } from './parser.js';

export { normalizeXendnowNumber, parseXendnow } from './parser.js';

/** The tracking API that XendNow's tracking page, `trace.aspx`, asks from the browser. */
export const XENDNOW_API = 'https://integration.xendnow.my/delivery_history.svc';
// The one credential the tracking page's script (js_custom/trace.js) sends for every visitor.
const CREDENTIAL = 'xenduser:XTeSWRxL'; // gitleaks:allow
const AUTHORIZATION = `Basic ${btoa(CREDENTIAL)}`;
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The API's address for one of its routes and a box. */
export const xendnowApiUrl = (route: 'track_parcel_history' | 'track_parcel_detail', number: string): string =>
  `${XENDNOW_API}/${route}/${encodeURIComponent(number)}`;

export class XendnowTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async call(route: 'track_parcel_history' | 'track_parcel_detail', number: string, signal: AbortSignal,
    timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(xendnowApiUrl(route, number), { method: 'GET', signal, headers: {
      Accept: 'application/json', Authorization: AUTHORIZATION, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: XENDNOW_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 404, 410] });
    // The API answers a missing or changed credential with 401 or 400, and an unknown box with an empty list.
    if (response.status === 400 || response.status === 401) {
      throw new SchemaError(PROVIDER, 'XendNow refused the credential of its tracking page', { status: response.status });
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'XendNow tracking API moved', { status: response.status });
    try {
      return parseJsonBytes(bytes, PROVIDER);
    } catch (cause) {
      if (CHALLENGE.test(decodeText(bytes.subarray(0, 64_000)))) {
        throw new ChallengeError(PROVIDER, 'XendNow answered with a browser check', { cause });
      }
      throw new SchemaError(PROVIDER, 'XendNow returned invalid tracking JSON', { cause });
    }
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The scans, and the box's card for a DHL hand-over: the tracking page asks for both. A failed request ends
    // the other, so neither outlives the attempt.
    const sibling = new AbortController();
    const both = AbortSignal.any([signal, sibling.signal]);
    const [history, detail] = await Promise.all([
      this.call('track_parcel_history', number, both, timeoutMs),
      this.call('track_parcel_detail', number, both, timeoutMs),
    ]).finally(() => sibling.abort());
    return parseXendnow(history, detail, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeXendnowNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XendnowTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
