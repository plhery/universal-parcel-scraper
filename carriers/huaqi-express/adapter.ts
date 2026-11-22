import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HUAQI_PAGE, huaqiLookupUrl, normalizeHuaqiNumber, parseHuaqi, PROVIDER } from './parser.js';

export { parseHuaqi } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

export class HuaqiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHuaqiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The waybill alone, as the page's search box sends it, with no session, captcha or account.
      const { response, bytes } = await fetchBounded(huaqiLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', Referer: HUAQI_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Huaqi refused its guest request');
      // An unknown waybill is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Huaqi tracking page moved', { status: response.status });
      return parseHuaqi(decodeText(bytes), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'huaqi-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HuaqiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'huaqi-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
