import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { RTB56_REDIRECTS, rtb56Json, rtb56LookupUrl } from '../yypost/rtb56.js';
import { normalizeZesExpressNumber, parseZesExpress, PROVIDER, ZES_MAX_BYTES } from './parser.js';

/** The guest tenant linked directly by the carrier's official site; it serves plain HTTP only. */
export const ZES_PAGE = 'http://120.26.82.200:8080/track_query.aspx';
export const ZES_API = 'http://120.26.82.200:8080/webservice/Service.ashx';
export const ZES_CALLBACK = 'zesExpressTrack';

export function zesExpressLookupUrl(number: string): string {
  return rtb56LookupUrl(ZES_API, ZES_CALLBACK, number);
}

export class ZesExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZesExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      const { response, bytes } = await fetchBounded(zesExpressLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/javascript, application/javascript, */*; q=0.01',
        Referer: `${ZES_PAGE}?${new URLSearchParams({ track_number: number })}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: ZES_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...RTB56_REDIRECTS, 404, 410] });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'ZES Express guest endpoint is unavailable', { status: response.status });
      return parseZesExpress(rtb56Json(decodeText(bytes), ZES_CALLBACK, PROVIDER), number);
    };
    return runSteps({ carrier: 'zes-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZesExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'zes-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZesExpressNumber(number))),
  };
};
