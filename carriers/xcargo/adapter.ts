import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { assertXcargoGuestText, MAX_BYTES, normalizeXcargoNumber, parseXcargo, PROVIDER, WIDGET_URL, xcargoUrl, xcargoVisitorToken } from './parser.js';

export class XcargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeXcargoNumber(raw);
    const attempt = async (signal: AbortSignal, budget: number): Promise<CarrierResult> => {
      const started = performance.now();
      const read = async (url: string, headers: Record<string, string>, kind: 'script' | 'history') => {
        const left = Math.floor(budget - (performance.now() - started));
        if (left < 1) throw new BudgetExceededError(PROVIDER, left);
        let reply: Awaited<ReturnType<typeof fetchBounded>>;
        try {
          reply = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent), ...headers } }, {
            provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: left, maxBytes: MAX_BYTES,
            redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 428] });
        } catch (error) {
          signal.throwIfAborted();
          // The visitor bearer, requested reference and upstream body must not escape in diagnostics.
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
          if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, 'X-Cargo could not read its guest tracker', {
            status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
          throw new TransportError(PROVIDER, 'X-Cargo could not read its guest tracker');
        }
        signal.throwIfAborted();
        const { response, bytes } = reply;
        if ([401, 403, 428].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
          throw new ChallengeError(PROVIDER, 'X-Cargo refused guest tracking');
        }
        if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'X-Cargo returned another guest route');
        const text = decodeText(bytes).replace(/^\uFEFF/, ''); assertXcargoGuestText(text);
        if (response.status !== 200 && !(kind === 'history' && response.status === 404)) {
          throw new TransportError(PROVIDER, 'X-Cargo guest endpoint is unavailable', { status: response.status });
        }
        const type = response.headers.get('content-type') ?? '';
        if (type && !(kind === 'script' ? /(?:java|ecma)script/i : /application\/(?:[a-z0-9.+-]+\+)?json/i).test(type)) {
          throw new SchemaError(PROVIDER, 'X-Cargo returned an unexpected response type');
        }
        return { text, status: response.status };
      };
      const widget = await read(WIDGET_URL, { Accept: 'text/javascript,application/javascript' }, 'script');
      const token = xcargoVisitorToken(widget.text);
      const history = await read(xcargoUrl(number), { Accept: 'application/json', Authorization: 'Bearer ' + token,
        Origin: 'https://x-cargo.co', Referer: 'https://x-cargo.co/' }, 'history');
      let payload: unknown;
      try { payload = JSON.parse(history.text); }
      catch { throw new SchemaError(PROVIDER, 'X-Cargo returned malformed tracking JSON'); }
      if (history.status === 404 && (!payload || typeof payload !== 'object')) throw new UpstreamHttpError(PROVIDER, 404);
      return parseXcargo(payload, number, history.status);
    };
    return runSteps({ carrier: 'xcargo', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new XcargoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'xcargo', steps: ['direct', 'retry'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
