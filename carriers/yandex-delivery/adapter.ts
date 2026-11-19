import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeYandexDeliveryNumber, parseYandexDeliveryPage, PROVIDER, YANDEX_DELIVERY_MAX_BYTES, YANDEX_DELIVERY_URL } from './parser.js';

export class YandexDeliveryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYandexDeliveryNumber(raw);
    return runSteps({ carrier: 'yandex-delivery', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The page's form sends the number by GET and the server renders the history, without a session.
      const url = `${YANDEX_DELIVERY_URL}?${new URLSearchParams({ order_tracking_id: number })}`;
      const { response, bytes } = await fetchBounded(url, { signal, method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ru-RU,ru;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: YANDEX_DELIVERY_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [301, 302, 303, 307, 308, 404],
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (response.status >= 300 && response.status < 400) {
        // Yandex sends a visitor it suspects of being a robot to its SmartCaptcha page.
        if (/showcaptcha|captcha/i.test(response.headers.get('location') ?? '')) throw new ChallengeError(PROVIDER, 'Yandex Delivery asked for its CAPTCHA');
        throw new TransportError(PROVIDER, `Yandex Delivery's tracker redirected with HTTP ${response.status}`);
      }
      // An unknown number answers HTTP 404 with the tracker's own not-found notice; the parser
      // requires that notice, so a bare 404 stays a failure.
      return parseYandexDeliveryPage(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YandexDeliveryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yandex-delivery', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
