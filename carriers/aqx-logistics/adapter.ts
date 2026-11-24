import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AQX_LOOKUP, AQX_MAX_BYTES, aqxJson, aqxRefusal, isAqxBlocked, normalizeAqxNumber, parseAqx, PROVIDER } from './parser.js';

export { AQX_LOOKUP, normalizeAqxNumber, parseAqx } from './parser.js';

const TRACKER_PAGE = 'https://aqxlogistics.com/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class AqxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The read the tracking page's script makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${AQX_LOOKUP}?id=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: `${TRACKER_PAGE}?id=${encodeURIComponent(number)}`,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AQX_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      // The site's firewall answers a request it refuses with a plain "Forbidden".
      if (isAqxBlocked(body)) throw new ChallengeError(PROVIDER, 'AQX Logistics answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'AQX Logistics refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // An unknown number gets HTTP 404 and the tracker's not-found answer in JSON; a 404 page
    // without it is a route the server no longer has.
    if ((status === 400 || status === 404) && json) return aqxRefusal(aqxJson(body), status);
    if (status !== 200) throw new TransportError(PROVIDER, 'AQX Logistics tracking is unavailable', { status });
    if (!json) {
      if (isAqxBlocked(body)) throw new ChallengeError(PROVIDER, 'AQX Logistics answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'AQX Logistics answered with a page instead of its tracking reply');
    }
    return parseAqx(aqxJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAqxNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers AQX Logistics for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new AqxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
