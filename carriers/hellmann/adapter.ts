import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HELLMANN_MAX_BYTES, hellmannPackageUrl, normalizeHellmannPackage, parseHellmannPackage, PROVIDER } from './parser.js';

export class HellmannTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeHellmannPackage(raw);
    return runSteps({ carrier: 'hellmann', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const reply = await fetchBounded(hellmannPackageUrl(number), { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs, maxBytes: HELLMANN_MAX_BYTES,
        redirect: 'error', allowHttpStatuses: [404] });
      // A generic unbound API error is not proof that this package does not exist.
      if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'Hellmann road tracking is unavailable', { status: reply.response.status });
      return parseHellmannPackage(decodeText(reply.bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HellmannTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'hellmann', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
