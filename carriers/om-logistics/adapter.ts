import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOmNumber, omChallenge, omJson, omSummary, OM_MAX_BYTES, parseOm, PROVIDER } from './parser.js';

export const OM_ENDPOINT = 'https://omlogisticssupplychain.com/api/track';

export class OmLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeOmNumber(raw);
    return runSteps({ carrier: 'om-logistics', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (params: Record<string, string>) => {
        signal.throwIfAborted();
        const left = Math.floor(deadline - performance.now());
        if (left < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const url = `${OM_ENDPOINT}?${new URLSearchParams(params)}`;
        try {
          const { response, bytes } = await fetchBounded(url, { signal, headers: {
            Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
          } }, { fetcher, provider: PROVIDER, timeoutMs: left, maxBytes: OM_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [400, 401, 403, 404, 410] });
          signal.throwIfAborted();
          if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Om Logistics refused its guest request');
          if ([301, 302, 303, 307, 308, 404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Om Logistics guest endpoint is unavailable', { status: response.status });
          const value = omJson(decodeText(bytes));
          if (response.status !== 200) throw new TransportError(PROVIDER, 'Om Logistics rejected its guest request', { status: response.status });
          return value;
        } catch (error) {
          signal.throwIfAborted();
          // Cookies and the URL contain per-session verification state. Keep kinds,
          // rate-limit hints and cancellation without retaining that state in errors.
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
          if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, error.message, {
            status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
          throw new TransportError(PROVIDER, 'Om Logistics could not read its guest tracker');
        }
      };
      const answer = omChallenge(await request({ type: 'captcha' }));
      const params = { cn_no: number, captcha_input: answer };
      const summary = await request({ ...params, type: 'enquiry' });
      omSummary(summary, number);
      return parseOm(summary, await request({ ...params, type: 'details' }), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OmLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'om-logistics', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
