import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isLmParcelReference } from '../../core/detection/lmParcel.js';
import { ChallengeError, SchemaError, TransportError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { LM_PARCEL_BASE, normalizeLmParcelNumber, parseLmParcel, parseLmParcelSummary, PROVIDER } from './parser.js';

export class LmParcelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeLmParcelNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const json = async (url: string, body?: string): Promise<unknown> => {
        signal.throwIfAborted();
        const left = Math.floor(deadline - performance.now());
        if (left < 1) throw new UpstreamNetworkError(PROVIDER, new DOMException('The tracking attempt timed out', 'TimeoutError'));
        const { response, bytes } = await fetchBounded(url, { ...(body ? { method: 'POST', body } : {}), signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent) },
        }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: left, maxBytes: 1024 * 1024, redirect: 'manual',
          allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
        signal.throwIfAborted();
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'LM Parcel refused public tracking');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'LM Parcel tracking is unavailable', { status: response.status });
        if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'LM Parcel returned another tracking route');
        const text = decodeText(bytes).replace(/^\uFEFF/, '');
        if (response.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human/i.test(text.slice(0, 64_000))) {
          throw new ChallengeError(PROVIDER, 'LM Parcel returned browser verification');
        }
        try { return JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'LM Parcel returned a reply that is not JSON'); }
      };
      const summary = await json(`${LM_PARCEL_BASE}findwaybill`, JSON.stringify([number]));
      const bound = parseLmParcelSummary(summary, number);
      const details = await json(`${LM_PARCEL_BASE}findwaybillDetails?waybillNo=${encodeURIComponent(String(bound.waybillNo))}`);
      return parseLmParcel(summary, details, number);
    };
    return runSteps({ carrier: 'lm-parcel', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LmParcelTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'lm-parcel', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => isLmParcelReference(number)),
  };
};
