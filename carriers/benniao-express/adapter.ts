import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BENNIAO_ENDPOINT, BENNIAO_ORIGIN, BENNIAO_PAGE, benniaoJson, normalizeBenniaoNumber, parseBenniao, PROVIDER } from './parser.js';

export { parseBenniao } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The page's signature, from https://www.benniaosuyun.com/static/js/api.js: the MD5 of the JSON
 * body followed by `&timestamp=` and the millisecond clock. The key the script passes to CryptoJS.MD5
 * is taken as options, not mixed in.
 */
export function benniaoSignature(body: string, timestamp: number): string {
  return createHash('md5').update(`${body}&timestamp=${timestamp}`).digest('hex');
}

export class BenniaoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeBenniaoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The search page's request: the waybill as JSON, signed as its script does, with no session, captcha or account.
      const body = JSON.stringify({ nums: [number] }), timestamp = (this.options.now ?? Date.now)();
      const { response, bytes } = await fetchBounded(BENNIAO_ENDPOINT, { method: 'POST', signal, body, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-Signature': benniaoSignature(body, timestamp),
        'X-Timestamp': String(timestamp), Origin: BENNIAO_ORIGIN, Referer: `${BENNIAO_PAGE}&keyword=${number}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Benniao refused its guest request');
      // An unknown waybill is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Benniao tracking endpoint moved', { status: response.status });
      return parseBenniao(benniaoJson(decodeText(bytes)), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'benniao-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BenniaoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'benniao-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
