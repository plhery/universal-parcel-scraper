import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isChallenge, normalizeXiongdaNumber, parseXiongda, PROVIDER, XIONGDA_MAX_BYTES } from './parser.js';

export { normalizeXiongdaNumber, parseXiongda } from './parser.js';

/** The firm's site, whose tracking page asks its interface for a waybill's rows. */
export const XIONGDA_SITE = 'https://www.xdint.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server is in China and sometimes slow to answer from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The interface the tracking page asks for one waybill. */
export function xiongdaLookupUrl(number: string): string {
  return `${XIONGDA_SITE}/ajax/jiekou.aspx?status=chaxunnew&no=${encodeURIComponent(number)}`;
}

export class XiongdaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(xiongdaLookupUrl(number), {
      signal, headers: { Accept: 'application/json, text/javascript, */*', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: XIONGDA_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved interface, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking interface is unavailable`, { status: response.status });
    }
    return parseXiongda(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeXiongdaNumber(raw);
    // A request that fails to reach the interface, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XiongdaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeXiongdaNumber(number))),
  };
};
