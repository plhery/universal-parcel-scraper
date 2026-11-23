import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { fetchGoldStarLineInBrowser } from './browser.js';
import {
  GOLD_STAR_LINE_LOOKUP, GOLD_STAR_LINE_MAX_BYTES, GOLD_STAR_LINE_PAGE, goldStarLineLookupBody, goldStarLinePageUrl, goldStarLineQuery,
  goldStarLineReplyText, PROVIDER, type GoldStarLineQuery,
} from './parser.js';

export { goldStarLineLookupBody, goldStarLinePageUrl, goldStarLineQuery, goldStarLineResult } from './parser.js';
export type { GoldStarLineQuery } from './parser.js';

// Akamai refuses the lookup to a client that does not name a browser.
export const GOLD_STAR_LINE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 15_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;

export interface GoldStarLineTrackerOptions {
  fetcher?: typeof fetch;
  /** A local Chromium, for when Akamai refuses the plain lookup. */
  executablePath?: string | null;
  recorder?: StepRecorder;
}

export class GoldStarLineTracker {
  constructor(private readonly options: GoldStarLineTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = goldStarLineQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Gold Star Line budget must be positive');
    const executablePath = this.options.executablePath ?? null;
    // A lookup that fails to reach Gold Star Line, or hangs, gets one more; a refused one goes to the page in a browser.
    return runSteps<CarrierResult>({ carrier: 'gold-star-line', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
      { id: 'browser', enabled: executablePath !== null, recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs }) => fetchGoldStarLineInBrowser(query, executablePath!, signal,
          Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }

  /** The lookup the page makes, sent as the page sends it. */
  private async read(query: GoldStarLineQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { bytes } = await fetchBounded(GOLD_STAR_LINE_LOOKUP, { method: 'POST', signal, body: goldStarLineLookupBody(query), headers: {
      Accept: '*/*', 'Content-Type': 'text/plain;charset=UTF-8', Origin: new URL(GOLD_STAR_LINE_PAGE).origin, Referer: goldStarLinePageUrl(query),
      'User-Agent': GOLD_STAR_LINE_USER_AGENT,
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GOLD_STAR_LINE_MAX_BYTES, fetcher: this.options.fetcher });
    return goldStarLineReplyText(decodeText(bytes), query);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GoldStarLineTracker({ fetcher: environment.fetcher, executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'gold-star-line', recordsSteps: true, steps: ['direct', 'retry', 'browser'],
    track: (input, context) => tracker.fetch(input.number, context) };
};
