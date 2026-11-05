import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { EXPEDICO_ENDPOINT, EXPEDICO_QUERY, normalizeExpedicoNumber, parseExpedico, PROVIDER } from './parser.js';

export class ExpedicoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeExpedicoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(EXPEDICO_ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ operationName: 'tracking', query: EXPEDICO_QUERY, variables: { codes: [number] } }),
      }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1024 * 1024,
        redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Expedico refused public tracking');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Expedico tracking is unavailable', { status: response.status });
      const text = decodeText(bytes).replace(/^\uFEFF/, '');
      if (response.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human/i.test(text.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'Expedico returned browser verification');
      }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'Expedico returned a reply that is not JSON'); }
      return parseExpedico(payload, number);
    };
    return runSteps({ carrier: 'expedico', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ExpedicoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'expedico', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
