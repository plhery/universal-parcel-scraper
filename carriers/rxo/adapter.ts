import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRxoBlocked, normalizeRxoNumber, parseRxo, PROVIDER, RXO_LOOKUP, RXO_MAX_BYTES, rxoJson } from './parser.js';

export { normalizeRxoNumber, parseRxo, RXO_LOOKUP } from './parser.js';

const TRACKER_PAGE = 'https://track.rxo.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
// The lookup takes long to answer for a known order, far longer than for an unknown number.
const DEFAULT_BUDGET_MS = 45_000;

/** The lookup's address for a number, as the tracking page builds it: every retailer (`billTo=0`). */
export function rxoLookupUrl(number: string): string {
  return `${RXO_LOOKUP}${encodeURIComponent(number)}?billTo=0`;
}

export class RxoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The read the tracking page's script makes for a tracking number. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The lookup reads Accept-Language as a culture and refuses fetch's default `*` with HTTP 400.
    const { response, bytes } = await fetchBounded(rxoLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US', Origin: 'https://track.rxo.com', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RXO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isRxoBlocked(body)) throw new ChallengeError(PROVIDER, 'RXO answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'RXO refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The lookup answers every number, known or not, with HTTP 200: a redirect or a 404 is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'RXO tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isRxoBlocked(body)) throw new ChallengeError(PROVIDER, 'RXO answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'RXO answered with a page instead of its tracking reply');
    }
    return parseRxo(rxoJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRxoNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers RXO for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RxoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
