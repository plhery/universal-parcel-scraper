import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { logisticsSolutionNumber, parseLogisticsSolution, PROVIDER } from './parser.js';

export const LOGISTICS_SOLUTION_ENDPOINT = 'https://logistics-solution.eu/api/tracking';

// The site's own answers for a number it has no parcel under, which its tracker reads as not found.
const MISSING = /^\s*\{\s*"error"\s*:\s*"(?:Tracking data not found|API returned status 404)"\s*\}\s*$/;
const BLOCK_PAGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt/i;

export class LogisticsSolutionTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = logisticsSolutionNumber(raw);
    const url = `${LOGISTICS_SOLUTION_ENDPOINT}?${new URLSearchParams({ barcode: number, language: 'en' })}`;
    return runSteps({ carrier: 'logistics-solution', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(url, {
        method: 'GET', signal,
        headers: { Accept: '*/*', Referer: 'https://logistics-solution.eu/en', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: remainingMs, fetcher: this.options.fetcher, maxBytes: 1_000_000, allowHttpStatuses: [404, 410] });
      if (!response.ok) {
        if (response.status === 404 && bytes.length <= 1_000 && MISSING.test(decodeText(bytes.subarray(0, 1_000)))) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Logistics Solution tracking endpoint is unavailable');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCK_PAGE.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Logistics Solution answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Logistics Solution returned invalid tracking JSON', { cause });
      }
      return parseLogisticsSolution(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LogisticsSolutionTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'logistics-solution', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
