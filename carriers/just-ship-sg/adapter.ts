import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JUST_SHIP_MAX_BYTES, normalizeJustShipNumber, parseJustShip, PROVIDER } from './parser.js';

export { normalizeJustShipNumber, parseJustShip } from './parser.js';

/** The tracking page, which reads the shipping ID from its `trackingNumber` parameter. */
export const JUST_SHIP_TRACKER = 'https://www.justship.sg/tracking';
/** The service the tracking page asks. */
export const JUST_SHIP_LOOKUP = 'https://www.justship.sg/api/shipment/tracking';
const ANSWERED = [301, 302, 303, 307, 308, 401, 403, 404, 410];
// Cloudflare and Vercel put their checks in front of the site as pages, sometimes with a 200.
const CHECK_PAGE = /challenge-platform|cf-chl|Just a moment|Attention Required|Vercel Security Checkpoint/i;
const DEFAULT_BUDGET_MS = 15_000;

export class JustShipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${JUST_SHIP_LOOKUP}?${new URLSearchParams({ trackingNumber: number })}`;
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'application/json', Referer: JUST_SHIP_TRACKER, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JUST_SHIP_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: ANSWERED });
    signal.throwIfAborted();
    const body = decodeText(bytes);
    if (response.status === 401 || response.status === 403 || response.headers.get('cf-mitigated') === 'challenge'
      || (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '') && CHECK_PAGE.test(body))) {
      throw new ChallengeError(PROVIDER, 'JustShip refused public tracking with a check');
    }
    // A redirect or a missing service is a moved tracker, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'JustShip tracking moved', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'JustShip answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'JustShip returned a reply that is not JSON', { cause: error });
    }
    return parseJustShip(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJustShipNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JustShipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
