import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { flechaReference, FLECHA_ENDPOINT, FLECHA_SCRIPT, MAX_BYTES, parseFlecha, PROVIDER, publicTrackingToken } from './parser.js';

export class FlechaCargaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const reference = flechaReference(raw);
    return runSteps({ carrier: 'flechacarga', signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const budget = lookupBudget({ signal, budgetMs: remainingMs }, remainingMs, PROVIDER);
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Referer: 'https://www.flechacarga.com/' };
      const script = await fetchBounded(FLECHA_SCRIPT, { signal: budget.signal, headers: { ...headers, Accept: 'text/javascript, */*' } }, {
        provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.min(5000, budget.remainingMs()), maxBytes: 64_000, redirect: 'error',
      });
      const token = publicTrackingToken(decodeText(script.bytes));
      const url = new URL(FLECHA_ENDPOINT);
      url.search = new URLSearchParams({ numero: reference, token }).toString();
      const reply = await fetchBounded(url, { signal: budget.signal, headers: {
        ...headers, Accept: '*/*', Origin: 'https://www.flechacarga.com',
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: budget.remainingMs(), maxBytes: MAX_BYTES, redirect: 'error' });
      return parseFlecha(decodeText(reply.bytes), raw);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FlechaCargaTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'flechacarga', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
