import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { altexNumber, altexTrackingUrl, ALTEX_MAX_BYTES, ALTEX_ORIGIN, parseAltex, PROVIDER } from './parser.js';

export class AltexCurierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = altexNumber(raw);
    return runSteps({ carrier: 'altex-curier', signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const result = await fetchBounded(altexTrackingUrl(number), { signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent), Referer: ALTEX_ORIGIN + '/',
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs,
        maxBytes: ALTEX_MAX_BYTES, redirect: 'error' });
      return parseAltex(decodeText(result.bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AltexCurierTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'altex-curier', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
