import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ArasKargoTracker } from '../aras-kargo/adapter.js';
import { arasNumberFor, arasPartnerFrame, normalizeYolNumber, parseFulAnswer, parseYolRoute, parseYolShipment, PROVIDER, YOL_MAX_BYTES, yolLookupUrl } from './parser.js';

export { parseYolShipment } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const ARAS_ORIGIN = 'https://kargotakip.araskargo.com.tr';

export class YolKargoTracker {
  private readonly aras: ArasKargoTracker;

  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {
    this.aras = new ArasKargoTracker({ fetcher: options.fetcher, userAgent: options.userAgent });
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYolNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      const get = async (url: string, allow: number[] = []) => {
        const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9',
          'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remaining(),
          maxBytes: YOL_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410, ...allow] });
        signal.throwIfAborted();
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'Yol Kargo refused public tracking');
        return { response, html: () => decodeText(bytes) };
      };
      const page = async (url: string) => {
        const answer = await get(url);
        // A missing or moved page is a changed tracker, not a missing shipment.
        if (answer.response.status !== 200) throw new TransportError(PROVIDER, 'Yol Kargo tracking is unavailable', { status: answer.response.status });
        return answer.html();
      };

      // The lookup redirects to the system that holds the number and lists it in its body.
      const lookup = await get(yolLookupUrl(number));
      if (lookup.response.status !== 302) throw new TransportError(PROVIDER, 'Yol Kargo lookup is unavailable', { status: lookup.response.status });
      const route = parseYolRoute(lookup.html(), lookup.response.headers.get('location'), number);
      if (route.system === 'none') parseFulAnswer(await page(route.url), number);
      if (route.system === 'yol') return parseYolShipment(await page(route.url), number);
      // A shipment Yol Kargo handed Aras Kargo: Aras Kargo's own tracker, under the number its page gives the shipment.
      const partner = await page(route.url.replace(/^http:\/\/kargotakip\.araskargo\.com\.tr/, ARAS_ORIGIN));
      const aras = arasNumberFor(await page(`${ARAS_ORIGIN}/${arasPartnerFrame(partner)}`), number);
      const result = await this.aras.fetch(aras, { signal, budgetMs: remaining() });
      return { ...result, delivery_carrier: 'aras-kargo', delivery_tracking_number: aras };
    };
    return runSteps({ carrier: 'yol-kargo', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YolKargoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'yol-kargo', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
