import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeYuemaNumber, parseYuema, PROVIDER, YUEMA_CALLBACK, YUEMA_MAX_BYTES, yuemaPayload } from './parser.js';

export { normalizeYuemaNumber, parseYuema, yuemaPayload } from './parser.js';

/** The tracking page on Yuema's site, whose script asks the lookup below. */
export const YUEMA_PAGE = 'https://www.yue777.com/genzong.php';
/** The lookup, which answers without a cookie, session or CAPTCHA. */
export const YUEMA_TRACE = 'https://oa.yue777.com/Weixin/Hg/trace';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The lookup's address for one waybill, with the callback the page's script names. */
export const yuemaTraceUrl = (number: string): string =>
  `${YUEMA_TRACE}?bill=${encodeURIComponent(number)}&callback=${YUEMA_CALLBACK}`;

export class YuemaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(yuemaTraceUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/javascript, application/javascript, */*; q=0.01', Referer: YUEMA_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: YUEMA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403] });
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Yuema Express refused its guest lookup');
    // An unknown waybill is HTTP 200 too; a redirect is a moved lookup.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Yuema Express tracking lookup moved', { status: response.status });
    return parseYuema(yuemaPayload(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYuemaNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new YuemaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
