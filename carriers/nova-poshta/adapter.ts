import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeNovaPoshtaNumber, parseNovaPoshta } from './parser.js';
const ENDPOINT = 'https://api.novaposhta.ua/v2.0/json/';
export class NovaPoshtaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeNovaPoshtaNumber(raw);
    return runSteps({ carrier: 'nova-poshta', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal, headers: { 'Content-Type': 'application/json',
          'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify({ modelName: 'TrackingDocument', calledMethod: 'getStatusDocuments',
            methodProperties: { Documents: [{ DocumentNumber: number, Phone: '' }], Language: 'EN' }, system: 'Tracking' }) }, {
            provider: 'Nova Poshta', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 500_000, fetcher: this.options.fetcher });
        return parseNovaPoshta(parseJsonBytes(bytes, 'Nova Poshta'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Nova Poshta', 'Nova Poshta tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new NovaPoshtaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'nova-poshta', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
