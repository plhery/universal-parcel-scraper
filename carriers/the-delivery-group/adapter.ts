import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTdgNumber, parseTdg, PROVIDER, TDG_MAX_BYTES, TDG_TRACKING_URL } from './parser.js';

export class TheDeliveryGroupTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, rawPostcode = '', context: TrackingContext = {}) {
    const number = normalizeTdgNumber(raw);
    const postcode = deliveryPostcodeText(rawPostcode);
    if (postcode && !DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'TDG takes a valid delivery postcode');
    return runSteps({ carrier: 'the-delivery-group', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const reply = await fetchBounded(TDG_TRACKING_URL, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent), Origin: 'https://tracking.dockethub.com',
        Referer: 'https://tracking.dockethub.com/shipment/?style=TDG',
      }, body: JSON.stringify({ trackingQuery: { Reference: number, Postcode: postcode } }) }, {
        provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs,
        maxBytes: TDG_MAX_BYTES, redirect: 'error',
      });
      return parseTdg(decodeText(reply.bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TheDeliveryGroupTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'the-delivery-group', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context) };
};
