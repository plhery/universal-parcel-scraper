import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BRIDGE_MAX_BYTES, CARRIER, isChallenge, normalizeBridgeNumber, parseBridge, PROVIDER } from './parser.js';

export { normalizeBridgeNumber, parseBridge } from './parser.js';

/** The query page, which puts the lookup's fragment in place. */
export const BRIDGE_PAGE = 'https://www.bri-ems.com/query';
/** The request the query page's script sends for a number. */
export const BRIDGE_LOOKUP = 'https://www.bri-ems.com/getorder.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class BridgeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(`${BRIDGE_LOOKUP}?q=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: '*/*', Referer: BRIDGE_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: BRIDGE_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const body = decodeText(bytes);
    // An unknown number is HTTP 200 too; anything else is a moved route, a refusal or a browser check.
    if (response.status !== 200) {
      if ((response.status === 403 || response.status === 503) && isChallenge(body)) {
        throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`, { status: response.status });
      }
      if (response.status === 503) throw new MaintenanceError(PROVIDER, undefined, { status: response.status });
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    }
    return parseBridge(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBridgeNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Bridge Intl, whose numbers share other carriers' shapes.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new BridgeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
