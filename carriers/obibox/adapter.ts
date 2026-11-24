import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isObiboxBlocked, isObiboxNotFound, normalizeObiboxNumber, OBIBOX_MAX_BYTES, obiboxJson, parseObibox, PROVIDER,
} from './parser.js';

export { normalizeObiboxNumber, parseObibox } from './parser.js';

/** The tracking page, whose script asks the tracker. */
export const OBIBOX_PAGE = 'https://tracking.obibox.io/';
/** The tracker the page's script asks, without a session, token or cookie. */
export const OBIBOX_TRACK = 'https://api.obibox.io/shipment_tracking/public/shipment_tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/**
 * The tracker's address for one number, as the page's script builds it: the number and the
 * flag that asks for a fresh answer. The page's random cache-busting values are left out.
 */
export function obiboxLookupUrl(number: string): string {
  return `${OBIBOX_TRACK}?${new URLSearchParams({ tracking_number: number, _force: '1' })}`;
}

export class ObiboxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(obiboxLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'Cache-Control': 'no-cache', 'X-Force-Refresh': '1', 'X-Requested-With': 'XMLHttpRequest',
      Referer: OBIBOX_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OBIBOX_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    const { status } = response;
    const body = decodeText(bytes);
    const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
    if (!json && isObiboxBlocked(body)) throw new ChallengeError(PROVIDER, 'Obibox answered with a browser check', { status });
    // The tracker answers an unknown number with HTTP 404 and its own message; any other 404, a
    // redirect or a gone route is a moved tracker.
    if (status === 404 && json) {
      const payload = obiboxJson(body);
      if (isObiboxNotFound(payload)) return parseObibox(payload, number);
    }
    if (status !== 200) throw new TransportError(PROVIDER, 'Obibox tracking is unavailable', { status });
    if (!json) throw new SchemaError(PROVIDER, 'Obibox answered with a page instead of its tracking reply');
    return parseObibox(obiboxJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeObiboxNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: Obibox's rule names it with high confidence, so preflight has no other carrier to tell it from.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new ObiboxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
