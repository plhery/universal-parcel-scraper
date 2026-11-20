import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeXlsFutarNumber, parseXlsFutar, PROVIDER, XLS_FUTAR_MAX_BYTES, xlsFutarTrackingUrl } from './parser.js';

export class XlsFutarTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeXlsFutarNumber(raw);
    return runSteps({ carrier: 'xls-futar', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const reply = await fetchBounded(xlsFutarTrackingUrl(number), { signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: remainingMs, maxBytes: XLS_FUTAR_MAX_BYTES,
        redirect: 'error', allowHttpStatuses: [404, 410] });
      if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'XLS Futár tracking is unavailable', { status: reply.response.status });
      return parseXlsFutar(decodeText(reply.bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new XlsFutarTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'xls-futar', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
