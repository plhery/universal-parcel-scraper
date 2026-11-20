import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { fetchZimInBrowser } from './browser.js';
import { PROVIDER, ZIM_MAX_BYTES, zimLookupUrl, zimQuery, zimReplyText, type ZimQuery } from './parser.js';

export { containerCheckDigit, zimLookupUrl, zimPageUrl, zimQuery, zimResult } from './parser.js';
export type { ZimQuery } from './parser.js';

// Akamai refuses the lookup to a client that does not name a browser.
export const ZIM_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 15_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;

export interface ZimTrackerOptions {
  fetcher?: typeof fetch;
  /** A local Chromium, for when Akamai refuses the plain lookup. */
  executablePath?: string | null;
  recorder?: StepRecorder;
}

export class ZimTracker {
  constructor(private readonly options: ZimTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = zimQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('ZIM budget must be positive');
    const executablePath = this.options.executablePath ?? null;
    // A lookup that fails to reach ZIM, or hangs, gets one more; a refused one goes to the page in a browser.
    return runSteps<CarrierResult>({ carrier: 'zim', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
      { id: 'browser', enabled: executablePath !== null, recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs }) => fetchZimInBrowser(query, executablePath!, signal, Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }

  /** The lookup the page makes, sent as the page sends it. */
  private async read(query: ZimQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { bytes } = await fetchBounded(zimLookupUrl(query), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: 'https://www.zim.com/', 'User-Agent': ZIM_USER_AGENT,
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZIM_MAX_BYTES, fetcher: this.options.fetcher });
    return zimReplyText(decodeText(bytes), query);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZimTracker({ fetcher: environment.fetcher, executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'zim', recordsSteps: true, steps: ['direct', 'retry', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
