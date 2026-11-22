import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DATIAN_FORM, datianLookupUrl, normalizeDatianNumber, parseDatian, PROVIDER } from './parser.js';

export { parseDatian } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

export class DatianTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDatianNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page the form redirects to, with the waybill alone: no session, captcha or account.
      const { response, bytes } = await fetchBounded(datianLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', Referer: DATIAN_FORM, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 2_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'DTW refused its guest request');
      // An unknown waybill is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'DTW tracking page moved', { status: response.status });
      return parseDatian(decodeText(bytes), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'datian-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DatianTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'datian-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDatianNumber(number))),
  };
};
