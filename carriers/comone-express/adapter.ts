import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COMONE_LOOKUP, COMONE_MAX_BYTES, comoneJson, isComoneBlocked, normalizeComoneNumber, parseComone, PROVIDER } from './parser.js';

export { COMONE_LOOKUP, normalizeComoneNumber, parseComone } from './parser.js';

const SITE = 'https://www.com1logistics.com';
const TRACKER_PAGE = `${SITE}/tracking.html`;
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class ComoneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The form post the tracking page's script makes for each number. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(COMONE_LOOKUP, { method: 'POST', signal, headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: SITE, Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ number }).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COMONE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isComoneBlocked(body)) throw new ChallengeError(PROVIDER, 'ComOne Express answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'ComOne Express refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'ComOne Express tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isComoneBlocked(body)) throw new ChallengeError(PROVIDER, 'ComOne Express answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'ComOne Express answered with a page instead of its tracking reply');
    }
    return parseComone(comoneJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeComoneNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: ComOne's nine digits are a shape many carriers share and no detection rule
// offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new ComoneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
