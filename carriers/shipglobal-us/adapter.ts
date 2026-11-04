import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isShipglobalUsReference } from '../../core/detection/shipglobalUs.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { SHIPGLOBAL_US_ENDPOINT, normalizeShipglobalUsNumber, parseShipglobalUs, PROVIDER } from './parser.js';

export class ShipglobalUsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeShipglobalUsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(SHIPGLOBAL_US_ENDPOINT, { method: 'POST', signal, headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent) }, body: new URLSearchParams({ waybill: number }).toString() },
        { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1024 * 1024,
          redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 400] });
      signal.throwIfAborted();
      if (response.status === 403) throw new ChallengeError(PROVIDER, PROVIDER + ' refused public tracking');
      if (response.status !== 200 && response.status !== 400) throw new TransportError(PROVIDER, PROVIDER + ' tracking is unavailable', { status: response.status });
      const text = decodeText(bytes).replace(/^\uFEFF/, '');
      if (response.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human/i.test(text.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, PROVIDER + ' returned browser verification');
      }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, PROVIDER + ' returned a reply that is not JSON'); }
      return parseShipglobalUs(payload, number, response.status);
    };
    return runSteps({ carrier: 'shipglobal-us', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ShipglobalUsTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'shipglobal-us', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => isShipglobalUsReference(number)),
  };
};
