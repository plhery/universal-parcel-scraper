import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePantosNumber, PANTOS_DETAIL_URL, PANTOS_LIST_URL, PANTOS_MAX_BYTES, PANTOS_PAGE, pantosBody, pantosDetailRequest,
  pantosShipment, parsePantos, PROVIDER } from './parser.js';

export class PantosTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePantosNumber(raw);
    return runSteps({ carrier: 'lx-pantos', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const started = Date.now();
      const post = async (url: string, body: unknown) => {
        const { bytes } = await fetchBounded(url, { method: 'POST', signal, body: JSON.stringify(body),
          headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.epantos.com', Referer: PANTOS_PAGE,
            'User-Agent': userAgentOf(this.options.userAgent) } }, {
          provider: PROVIDER, timeoutMs: Math.max(1, remainingMs - (Date.now() - started)), maxBytes: PANTOS_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher,
        }).catch(error => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        return pantosBody(decodeText(bytes));
      };
      const shipment = pantosShipment(await post(PANTOS_LIST_URL, { quickNo: number, locale: 'en' }), number);
      return parsePantos(shipment, await post(PANTOS_DETAIL_URL, pantosDetailRequest(shipment)));
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PantosTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'lx-pantos', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
