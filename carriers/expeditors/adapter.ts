import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { EXPEDITORS_MAX_BYTES, normalizeExpeditorsNumber, parseExpeditors, pickExpeditorsShipment, PROVIDER } from './parser.js';

export { normalizeExpeditorsNumber, parseExpeditors, pickExpeditorsShipment } from './parser.js';

/** The service behind the guest tracker at go2expo.expeditors.com/anonymous-track. */
export const EXPEDITORS_API = 'https://go2expo-api.expeditors.com/api/visibility';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is a moved service: the service answers an unknown reference with an empty list.
const GONE = [404, 410];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The guest search for a reference, which the tracker's results page asks first. */
export const expeditorsSearchUrl = (number: string): string =>
  `${EXPEDITORS_API}/guest-shipment-search?${new URLSearchParams({ searchReference: number })}`;
/** A section of a shipment's guest page: its details or its events. */
export const expeditorsDetailUrl = (number: string, section: 'details' | 'events'): string =>
  `${EXPEDITORS_API}/shipment-detail/${encodeURIComponent(number)}/${section}`;

export class ExpeditorsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: EXPEDITORS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Expeditors tracking service moved', { status: response.status });
    try {
      return parseJsonBytes(bytes, PROVIDER);
    } catch (cause) {
      if (CHALLENGE.test(decodeText(bytes.subarray(0, 64_000)))) {
        throw new ChallengeError(PROVIDER, 'Expeditors answered with a browser check', { cause });
      }
      throw new SchemaError(PROVIDER, 'Expeditors returned a reply that is not JSON', { cause });
    }
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const { shipment } = pickExpeditorsShipment(await this.get(expeditorsSearchUrl(number), signal, left()), number);
    signal.throwIfAborted();
    // The search gives the last status alone. The shipment's page reads its events, and its details
    // when the search listed it among others; a failed request ends the other.
    const sibling = new AbortController();
    const both = AbortSignal.any([signal, sibling.signal]);
    const timeout = left();
    const [details, events] = await Promise.all([
      shipment ?? this.get(expeditorsDetailUrl(number, 'details'), both, timeout),
      this.get(expeditorsDetailUrl(number, 'events'), both, timeout),
    ]).finally(() => sibling.abort());
    return parseExpeditors(details, events, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExpeditorsNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExpeditorsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
