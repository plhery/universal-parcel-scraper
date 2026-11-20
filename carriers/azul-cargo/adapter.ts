import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { AZUL_CARGO_MAX_BYTES, azulCargoTrackingUrl, normalizeAzulCargoNumber, parseAzulCargo, PROVIDER } from './parser.js';

export { azulCargoTrackingUrl, normalizeAzulCargoNumber, parseAzulCargo } from './parser.js';

const SERVICE_MS = 30_000;

export class AzulCargoTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeAzulCargoNumber(raw);
    const trawl = this.options.trawl;
    // Akamai refuses plain HTTP clients the tracker's pages, its home page included.
    if (!trawl) throw new ChallengeError(PROVIDER, 'Azul Cargo Express requires the browser tracking service');
    return runSteps({ carrier: 'azul-cargo', budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - 2000));
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const url = azulCargoTrackingUrl(number);
        const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs },
          { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal, fetcher: this.options.fetcher, maxBytes: 3 * AZUL_CARGO_MAX_BYTES });
        signal.throwIfAborted();
        if (page.url !== url) throw new IndeterminateError(PROVIDER, 'Azul Cargo Express redirected the requested tracking page');
        return parseAzulCargo(page.html, number, (this.options.now ?? Date.now)());
      } },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AzulCargoTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'azul-cargo', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
