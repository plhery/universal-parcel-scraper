import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BH_POSTA_TRACKER, bhPostaFormFields, normalizeBhPostaNumber, parseBhPosta, PROVIDER } from './parser.js';

export class BhPostaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBhPostaNumber(raw);
    return runSteps({ carrier: 'bh-posta', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs, session = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (init: RequestInit) => {
        signal.throwIfAborted();
        const left = Math.floor(deadline - performance.now());
        if (left <= 0) throw new BudgetExceededError(PROVIDER, remainingMs);
        try {
          const { response, bytes } = await fetchBounded(BH_POSTA_TRACKER, { ...init, signal }, {
            provider: PROVIDER, timeoutMs: left, maxBytes: 900_000, redirect: 'manual', fetcher: session,
            allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410],
          });
          if (response.status !== 200) throw new TransportError(PROVIDER, 'BH Pošta tracking page is unavailable', { status: response.status });
          return decodeText(bytes);
        } catch (error) {
          // A refused form can echo its state; capabilities do not belong in errors.
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
          throw error;
        }
      };
      const form = await read({ method: 'GET', headers });
      const fields = bhPostaFormFields(form, number);
      const html = await read({ method: 'POST', body: fields.toString(), headers: { ...headers,
        'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(BH_POSTA_TRACKER).origin, Referer: BH_POSTA_TRACKER } });
      return parseBhPosta(html, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BhPostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'bh-posta', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeBhPostaNumber(number))) };
};
