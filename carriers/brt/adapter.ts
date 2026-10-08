import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { brtParcelListPath, normalizeBrtNumber, parseBrt } from './parser.js';

const BASE = 'https://vas.brt.it/vas/';

export class BrtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBrtNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    return runSteps({ carrier: 'brt', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const deadline = performance.now() + remainingMs;
      const page = async (url: string, form?: Record<string, string>): Promise<string> => {
        const left = deadline - performance.now();
        if (left <= 0) throw new BudgetExceededError('BRT', budgetMs);
        const { response, bytes } = await fetchBounded(url,
          { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            ...(form ? { method: 'POST', body: new URLSearchParams(form).toString() } : {}) },
          { provider: 'BRT', timeoutMs: Math.max(1, Math.floor(left)), maxBytes: 1_000_000,
            redirect: 'manual', allowHttpStatuses: [302, 404, 410], fetcher: this.options.fetcher });
        if (performance.now() >= deadline) throw new BudgetExceededError('BRT', budgetMs);
        signal.throwIfAborted();
        if (response.status !== 200) throw new IndeterminateError('BRT', 'BRT tracking endpoint is unavailable');
        const charset = /charset\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]!.toLowerCase();
        if (charset && !['utf-8', 'utf8', 'iso-8859-1', 'windows-1252'].includes(charset)) throw new SchemaError('BRT', 'BRT response encoding changed');
        return decodeText(bytes, charset?.startsWith('utf') ? 'utf-8' : 'windows-1252');
      };
      if (number.length === 14) return parseBrt(await page(`${BASE}sped_det_new.htm?brtCode=${number}&lang=en`), number);
      if (number.length === 12) {
        return parseBrt(await page(`${BASE}sped_det_show.hsm?lang=en`,
          { Nspediz: number, referer: 'sped_numspe_par.htm', RicercaNumeroSpedizione: 'Ricerca', lang: 'en' }), number);
      }
      // A parcel ID goes through the form's customer parcel ID search. Its
      // result does not repeat the ID, so the shipment's parcel list must name it.
      const detail = await page(`${BASE}sped_det_show.hsm?lang=en`, { referer: 'sped_numspe_par.htm', ChiSono: number,
        ClienteMittente: '', DataInizio: '', DataFine: '', RicercaChiSono: 'Ricerca', lang: 'en' });
      return parseBrt(detail, number, await page(new URL(brtParcelListPath(detail), BASE).href));
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BrtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'brt', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeBrtNumber(number))) };
};
