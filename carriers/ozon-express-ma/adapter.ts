import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isOzonBlocked, normalizeOzonNumber, OZON_LOOKUP, OZON_MAX_BYTES, parseOzon, PROVIDER } from './parser.js';

export { normalizeOzonNumber, OZON_LOOKUP, parseOzon } from './parser.js';

const SITE = 'https://ozonexpress.ma';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class OzonTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The form post the tracking box's script makes for each number. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const form = new FormData();
    form.append('tracking-number', number);
    const { response, bytes } = await fetchBounded(OZON_LOOKUP, { method: 'POST', signal, headers: {
      Accept: '*/*', Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: form }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OZON_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 429, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 429) throw new RateLimitedError(PROVIDER);
    if (status === 401 || status === 403 || status === 503) {
      if (isOzonBlocked(body)) throw new ChallengeError(PROVIDER, 'Ozon Express answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Ozon Express refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Ozon Express tracking is unavailable', { status });
    // The reply is an HTML card, though it is labelled JSON.
    return parseOzon(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOzonNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: Ozon's codes follow no published layout and sellers may choose their own, so
// no detection rule offers it and preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new OzonTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
