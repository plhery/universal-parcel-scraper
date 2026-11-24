import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BOXC_LOOKUP, BOXC_MAX_BYTES, boxcJson, isBoxcBlocked, normalizeBoxcNumber, parseBoxc, PROVIDER } from './parser.js';

export { BOXC_LOOKUP, normalizeBoxcNumber, parseBoxc } from './parser.js';

const TRACKER_PAGE = 'https://boxc.com/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class BoxcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the tracking page's script makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(BOXC_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: 'https://boxc.com', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ trackingNumber: number }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BOXC_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      if (isBoxcBlocked(body)) throw new ChallengeError(PROVIDER, 'BoxC answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'BoxC refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if ((status === 400 || status === 404) && json) {
      // The tracker words its refusals as its 200 replies do: only its own not-found answer is
      // read as not found. A 404 without one is a route the server no longer has.
      const payload = boxcJson(body);
      if (isRecord(payload) && payload.success === false) return parseBoxc(payload, number);
      if (status === 404) throw new TransportError(PROVIDER, 'BoxC tracking is unavailable', { status });
      throw new IndeterminateError(PROVIDER, 'BoxC did not complete the lookup', { status });
    }
    // A redirect, or a 404 without the tracker's JSON, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'BoxC tracking is unavailable', { status });
    if (!json) {
      // The site answers an unknown path with its tracking app's page, so a page is a changed tracker.
      if (isBoxcBlocked(body)) throw new ChallengeError(PROVIDER, 'BoxC answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'BoxC answered with a page instead of its tracking reply');
    }
    return parseBoxc(boxcJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBoxcNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers BoxC for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new BoxcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
