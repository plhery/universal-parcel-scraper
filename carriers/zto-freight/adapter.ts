import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZtoFreightNumber, parseZtoFreight, PROVIDER, ZTO_FREIGHT_ENDPOINT, ZTO_FREIGHT_ORIGIN, ZTO_FREIGHT_PAGE, ztoFreightJson } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];

export class ZtoFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZtoFreightNumber(raw);
    const url = `${ZTO_FREIGHT_ENDPOINT}?${new URLSearchParams({ billCodes: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The tracker's page sends its JSON content type, its origin and its own address as
      // referrer; without them the reply leaves out every waybill, as it does for an unknown one.
      // The origin matters once fetch adds its own Sec-Fetch-Mode. The slider the page shows
      // first is checked in the browser only.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json',
        Origin: ZTO_FREIGHT_ORIGIN, Referer: ZTO_FREIGHT_PAGE, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 2_000_000, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'ZTO Freight refused its guest request');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'ZTO Freight tracking endpoint moved', { status: response.status });
      return parseZtoFreight(ztoFreightJson(decodeText(bytes)), number);
    };
    // A read that fails to reach the tracker, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'zto-freight', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZtoFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zto-freight', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZtoFreightNumber(number))),
  };
};
