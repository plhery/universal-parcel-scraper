import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseQuickFort, PROVIDER, quickFortNumber } from './parser.js';

export const QUICK_FORT_ENDPOINT = 'https://www.quick-fort.com/search_kuai_di/search/orderid/';

export class QuickFortTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = quickFortNumber(raw);
    return runSteps({ carrier: 'quick-fort', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${QUICK_FORT_ENDPOINT}${number}`, {
        // The site answers HTTP 500 to a request without a language it can read, such as Node's `*`.
        signal, headers: { Accept: 'text/html', 'Accept-Language': 'zh-CN', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: remainingMs, fetcher: this.options.fetcher, maxBytes: 1_000_000, allowHttpStatuses: [404, 410] });
      if (!response.ok) throw new TransportError(PROVIDER, 'Quick Fort tracking endpoint is unavailable');
      const html = decodeText(bytes);
      if (/<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt/i.test(html.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'Quick Fort answered with a block page');
      }
      return parseQuickFort(html, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new QuickFortTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Rows of the planned timeline dated after the lookup wait until they are due.
  return { id: 'quick-fort', recordsSteps: true, plannedScans: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
