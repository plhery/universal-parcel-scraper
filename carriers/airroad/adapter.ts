import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  AIRROAD_LOOKUP, AIRROAD_MAX_BYTES, airroadJson, airroadNotFoundNumber, isAirroadBlocked, normalizeAirroadNumber, parseAirroad, PROVIDER,
} from './parser.js';

export { AIRROAD_LOOKUP, normalizeAirroadNumber, parseAirroad } from './parser.js';

const TRACKER_PAGE = 'https://www.airroad.com.au/quick-track/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class AirroadTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The read the Quick Track page's script makes for each number. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${AIRROAD_LOOKUP}${number}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', Origin: 'https://www.airroad.com.au', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AIRROAD_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      if (isAirroadBlocked(body)) throw new ChallengeError(PROVIDER, 'AirRoad answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'AirRoad refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if ((status === 400 || status === 404) && json) {
      // A number the lookup does not know gets HTTP 404 and "<number> not found.", naming the
      // number asked. Any other refusal leaves the answer open, and a route the server no longer
      // has is a moved tracker.
      const payload = airroadJson(body);
      const named = airroadNotFoundNumber(payload);
      if (status === 404 && named === number) throw new NotFoundError(PROVIDER, 'AirRoad has no consignment under this number');
      if (status === 404 && !named) throw new TransportError(PROVIDER, 'AirRoad tracking is unavailable', { status });
      throw new IndeterminateError(PROVIDER, 'AirRoad did not complete the lookup', { status });
    }
    // A redirect, or a 404 without the lookup's JSON, as a missing route gives, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'AirRoad tracking is unavailable', { status });
    if (!json) {
      if (isAirroadBlocked(body)) throw new ChallengeError(PROVIDER, 'AirRoad answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'AirRoad answered with a page instead of its tracking reply');
    }
    return parseAirroad(airroadJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAirroadNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers AirRoad for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new AirroadTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
