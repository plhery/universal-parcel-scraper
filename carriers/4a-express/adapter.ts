import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FOUR_A_LOOKUP, FOUR_A_MAX_BYTES, fourAJson, isFourABlocked, normalizeFourANumber, parseFourA, PROVIDER } from './parser.js';

export { FOUR_A_LOOKUP, normalizeFourANumber, parseFourA } from './parser.js';

const TRACKER_PAGE = 'https://cms.4aexpress.com/Query/TrackAwbNoQuery.aspx';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class FourATracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the tracking page's script makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(FOUR_A_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/json; charset=utf-8', Origin: 'https://cms.4aexpress.com',
      Referer: TRACKER_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ AWBNo: number }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FOUR_A_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 429, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 429) throw new RateLimitedError(PROVIDER);
    if (status === 401 || status === 403 || status === 503) {
      if (isFourABlocked(body)) throw new ChallengeError(PROVIDER, '4A Express answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, '4A Express refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // A redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, '4A Express tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isFourABlocked(body)) throw new ChallengeError(PROVIDER, '4A Express answered with a browser check', { status });
      throw new SchemaError(PROVIDER, '4A Express answered with a page instead of its tracking reply');
    }
    return parseFourA(fourAJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFourANumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: 4A Express's twelve-digit waybills are a bare digit run many carriers share, so
// no detection rule offers it and preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new FourATracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
