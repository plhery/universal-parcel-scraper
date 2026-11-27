import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSkynetInNumber, parseSkynetInReply, PROVIDER, SKYNET_IN_MAX_BYTES } from './parser.js';

export { normalizeSkynetInNumber, parseSkynetIn, parseSkynetInReply, SKYNET_IN_SOURCE, withoutPeople } from './parser.js';

const SITE = 'https://www.skynetww.com';
/** The service Skynet India's tracking page posts its numbers to. */
export const SKYNET_IN_API = `${SITE}/api/tracking`;
/** The tracking page, which opens one number from `awb`. */
const PAGE = `${SITE}/in-en/tracking`;
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class SkynetInTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's script posts the numbers as JSON from the same site; it sends no cookie, token or market.
    const { response, bytes } = await fetchBounded(SKYNET_IN_API, { method: 'POST', signal, body: JSON.stringify({ awbs: [number] }), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: SITE, Referer: PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SKYNET_IN_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] })
      // A request the caller cancelled ends with the caller's reason.
      .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
    signal.throwIfAborted();
    // The service answers an unknown number in its JSON, so a missing route has moved, not the parcel.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Skynet India tracking service moved', { status: response.status });
    }
    return parseSkynetInReply(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSkynetInNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkynetInTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
