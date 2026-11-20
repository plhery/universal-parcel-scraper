import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTramacoNumber, parseTramaco, PROVIDER, TRAMACO_MAX_BYTES, tramacoTrackingUrl } from './parser.js';

export class TramacoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeTramacoNumber(raw);
    return runSteps({ carrier: 'tramaco', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const reply = await fetchBounded(tramacoTrackingUrl(number), { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.tramaco.com.ec/rastreo.html',
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs,
        maxBytes: TRAMACO_MAX_BYTES, redirect: 'error', allowHttpStatuses: [502] });
      return parseTramaco(decodeText(reply.bytes), number, reply.response.status);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TramacoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'tramaco', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
