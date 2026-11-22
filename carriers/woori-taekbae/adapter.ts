import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeWooriNumber, parseWoori, PROVIDER, WOORI_MAX_BYTES } from './parser.js';

export { normalizeWooriNumber, parseWoori, wooriClock } from './parser.js';

/**
 * The lookup Woori Taekbae's tracking page makes for the number typed in. The page is served and
 * posts over plain HTTP; the host's HTTPS certificate is invalid, so the lookup stays on HTTP.
 */
export const WOORI_LOOKUP = 'http://www.honamlogis.co.kr/tracking_number.php';
// The lookup answers an unknown number with HTTP 200: a redirect or a missing route is a moved lookup.
const MOVED = [301, 302, 303, 307, 308, 404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class WooriTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page posts the number as a form, as jQuery sends it.
    const { response, bytes } = await fetchBounded(WOORI_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ SLIP_BARCD: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: WOORI_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: MOVED });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Woori Taekbae moved its tracking lookup', { status: response.status });
    // JSON in UTF-8, served as HTML without a charset.
    return parseWoori(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWooriNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WooriTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
