import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isPremoBlocked, normalizePremoNumber, parsePremo, PREMO_MAX_BYTES, PREMO_TRACKER, PROVIDER } from './parser.js';

export { normalizePremoNumber, parsePremo, PREMO_TRACKER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const HTML_TYPE = /^text\/html\b/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The address of Premo's tracking page for one number, as its search form builds it. */
export function premoTrackingUrl(raw: string): string {
  return `${PREMO_TRACKER}?${new URLSearchParams({ id: normalizePremoNumber(raw) }).toString()}`;
}

export class PremoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The tracking page for the number, as the search form opens it. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(premoTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'sv-SE,sv;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PREMO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isPremoBlocked(body)) throw new ChallengeError(PROVIDER, 'Premo answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Premo refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The page answers an unknown number with HTTP 200; a redirect or a missing page is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Premo tracking is unavailable', { status });
    if (!HTML_TYPE.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'Premo answered with something other than its tracking page');
    }
    return parsePremo(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePremoNumber(raw);
    // A read that fails to reach Premo, or hangs, is sent once more: the first try gets half of
    // the budget. An HTTP status or a page is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Premo, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new PremoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
