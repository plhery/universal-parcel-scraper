import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTlaBlocked, normalizeTlaNumber, parseTla, PROVIDER, TLA_LOOKUP, TLA_MAX_BYTES } from './parser.js';

export { normalizeTlaNumber, parseTla, TLA_LOOKUP } from './parser.js';

const SITE = 'https://toplogistics.com.au/';
const REDIRECTS = [301, 302, 303, 307, 308];
const HTML_TYPE = /^text\/html\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class TlaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The tracking frame the site's search opens for the number. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${TLA_LOOKUP}?${new URLSearchParams({ s: number }).toString()}`, { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', Referer: `${SITE}?s=${encodeURIComponent(number)}`,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TLA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 500, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isTlaBlocked(body)) throw new ChallengeError(PROVIDER, 'Top Logistics Australia answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Top Logistics Australia refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The frame answers a number it does not know with an empty HTTP 500, the same answer a failed
    // lookup gives, so it leaves the answer open; it has no not-found page.
    if (status === 500) {
      if (isTlaBlocked(body)) throw new ChallengeError(PROVIDER, 'Top Logistics Australia answered with a browser check', { status });
      throw new IndeterminateError(PROVIDER, 'Top Logistics Australia did not complete the lookup', { status });
    }
    // A redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Top Logistics Australia tracking is unavailable', { status });
    if (isTlaBlocked(body)) throw new ChallengeError(PROVIDER, 'Top Logistics Australia answered with a browser check', { status });
    if (!HTML_TYPE.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'Top Logistics Australia answered with something other than its tracking page');
    }
    return parseTla(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTlaNumber(raw);
    // A read that fails to reach the frame, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: the frame cannot tell a number it lacks from a failure, and no detection rule
// offers Top Logistics Australia, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new TlaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
