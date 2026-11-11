import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSengiExpressNumber, parseSengiExpress, PROVIDER, SENGI_MAX_BYTES, SENGI_SDA_WAYBILL } from './parser.js';

export const SENGI_PAGE = 'https://portal.sengiexpress.com/';
export const SENGI_API = 'https://portal.sengiexpress.com/api-v2/tracking/web';
const BLOCKED = /captcha|challenge|just a moment|access denied|forbidden|verify you are human/i;

export class SengiExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSengiExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      const { bytes } = await fetchBounded(SENGI_API, {
        method: 'POST', signal, body: JSON.stringify({ trackingNumberList: [number], type: 1 }),
        headers: {
          Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
          Origin: SENGI_PAGE.slice(0, -1), Referer: SENGI_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
        },
      }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: SENGI_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)) });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        // A page in place of the tracker's JSON is a block, whatever its HTTP status; anything else is malformed.
        if (/^\s*</.test(body) && BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sengi Express answered with a bot check', { cause });
        throw new SchemaError(PROVIDER, 'Sengi Express returned a reply that is not JSON', { cause });
      }
      return parseSengiExpress(payload, number);
    };
    return runSteps({ carrier: 'sengi-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SengiExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'sengi-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      // Its tracker also finds Poste Italiane's codes for the parcels it carries: only the SDA waybill makes the parcel Sengi's.
      () => accepted(() => normalizeSengiExpressNumber(number)) && SENGI_SDA_WAYBILL.test(normalizeSengiExpressNumber(number))),
  };
};
