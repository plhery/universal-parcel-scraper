import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeShipterNumber, parseShipter, PROVIDER, SHIPTER_ENDPOINT } from './parser.js';

const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];
const BLOCK = /_cf_chl_opt|cf-turnstile|cf-mitigated|<title>\s*(?:Just a moment|Access Denied|Attention Required)|captcha|verify (?:that )?you are human|request (?:was )?blocked|접근.{0,8}차단/i;

export class ShipterTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(SHIPTER_ENDPOINT, {
      method: 'POST', signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      body: JSON.stringify({ trackNos: [number] }),
    }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs, maxBytes: 1024 * 1024,
      redirect: 'manual', allowHttpStatuses: UNAVAILABLE });
    if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Shipter tracking service is unavailable');
    const text = decodeText(bytes).replace(/^\uFEFF/, '');
    if (response.headers.get('cf-mitigated') === 'challenge' || BLOCK.test(text.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'Shipter answered with a block page');
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch {
      throw new SchemaError(PROVIDER, 'Shipter returned a reply that is not JSON');
    }
    return parseShipter(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShipterNumber(raw);
    return await runSteps({ carrier: 'shipter', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShipterTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'shipter', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeShipterNumber(number))),
  };
};
