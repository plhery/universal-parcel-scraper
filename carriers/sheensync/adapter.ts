import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json } from '../yypost/rtb56.js';
import { CARRIER, normalizeSheensyncNumber, parseSheensync, PROVIDER, SHEENSYNC_MAX_BYTES } from './parser.js';

export const SHEENSYNC_PAGE = 'https://sheen-sync.com/track.html';
export const SHEENSYNC_API = 'https://sheen-sync.com/api/track';

/** The lookup the tracking page makes for one number. */
export function sheensyncLookupUrl(number: string): string {
  return `${SHEENSYNC_API}?${new URLSearchParams({ nums: number })}`;
}

export class SheensyncTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSheensyncNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The number alone, with no session, token or key.
      const { response, bytes } = await fetchBounded(sheensyncLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: `${SHEENSYNC_PAGE}?${new URLSearchParams({ c: number })}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: SHEENSYNC_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SheenSync tracking lookup is unavailable', { status: response.status });
      // Plain JSON: no callback name matches, so the body is read whole.
      return parseSheensync(rtb56Json(decodeText(bytes), 'jsonp', PROVIDER), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SheensyncTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSheensyncNumber(number))),
  };
};
