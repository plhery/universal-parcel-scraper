import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeFanCourierInternationalNumber, parseFanCourierInternational, PROVIDER, readFanCourierInternationalRefusal,
} from './parser.js';

/** The tracking page's own lookup. It needs neither the page's session nor its XSRF token. */
const ENDPOINT = 'https://fancourier.eu/API/status';
// Cloudflare's interstitial, served with a 200 or a 403.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|\bcf[-_]chl|challenge-platform/i;

export class FanCourierInternationalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFanCourierInternationalNumber(raw);
    return runSteps({ carrier: 'fan-courier-international', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        // The English page's locale; the sentences come in English either way.
        body: JSON.stringify({ trackingNumber: number, locale: 'en' }),
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [401, 403, 404, 422], fetcher: this.options.fetcher });
      const text = decodeText(bytes.subarray(0, 4_096));
      if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'FAN Courier International asked for a browser check', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'FAN Courier International refused the lookup', { status: 403 });
      // The number was checked before the request: a validation refusal says nothing about the shipment.
      if (response.status === 422) throw new IndeterminateError(PROVIDER, 'FAN Courier International refused the number (HTTP 422)');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'FAN Courier International returned invalid tracking JSON', { cause }); }
      if (response.status !== 200) readFanCourierInternationalRefusal(payload, number);
      return parseFanCourierInternational(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FanCourierInternationalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'fan-courier-international', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFanCourierInternationalNumber(number))) };
};
