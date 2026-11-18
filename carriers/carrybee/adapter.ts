import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { CARRYBEE_ENDPOINT, isCarryBeeNotFound, normalizeCarryBeeNumber, parseCarryBee, PROVIDER } from './parser.js';

export class CarryBeeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCarryBeeNumber(raw);
    const url = CARRYBEE_ENDPOINT + '?' + new URLSearchParams({ consignment_id: number }).toString();
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
          Origin: 'https://carrybee.com', Referer: 'https://carrybee.com/' },
      }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: 1024 * 1024, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) throw new ChallengeError(PROVIDER, 'CarryBee refused public tracking');
      if (response.status !== 200 && response.status !== 404) throw new TransportError(PROVIDER, 'CarryBee tracking is unavailable', { status: response.status });
      const body = decodeText(bytes).replace(/^\uFEFF/, '');
      if (response.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human/i.test(body.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'CarryBee returned browser verification');
      }
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'CarryBee returned a reply that is not JSON'); }
      // Only the service's own "record not found" makes a 404 an absence; any other 404 is a route or gateway answer.
      if (response.status === 404 && !isCarryBeeNotFound(payload)) throw new IndeterminateError(PROVIDER, 'CarryBee answered 404 without its not-found reply');
      return parseCarryBee(payload, number);
    };
    return runSteps({ carrier: 'carrybee', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CarryBeeTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'carrybee', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
