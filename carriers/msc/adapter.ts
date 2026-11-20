import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { fetchMscInBrowser } from './browser.js';
import { MSC_LOOKUP, MSC_MAX_BYTES, MSC_PAGE, mscQuery, mscReplyText, mscRequestBody, PROVIDER, type MscQuery } from './parser.js';

export { containerCheckDigit, mscPageUrl, mscQuery, mscRequestBody, mscResult } from './parser.js';
export type { MscQuery } from './parser.js';

// Akamai refuses the lookup to a client that does not name a browser.
export const MSC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const DEFAULT_BUDGET_MS = 45_000;
const DIRECT_LIMIT_MS = 15_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;

export interface MscTrackerOptions {
  fetcher?: typeof fetch;
  /** A local Chromium, for when Akamai refuses the plain lookup. */
  executablePath?: string | null;
  recorder?: StepRecorder;
}

export class MscTracker {
  constructor(private readonly options: MscTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = mscQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('MSC budget must be positive');
    const executablePath = this.options.executablePath ?? null;
    // A lookup that fails to reach MSC, or hangs, gets one more; a refused one goes to the page in a browser.
    return runSteps<CarrierResult>({ carrier: 'msc', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
      { id: 'browser', enabled: executablePath !== null, recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs }) => fetchMscInBrowser(query, executablePath!, signal, Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }

  /** The lookup the page makes, sent as the page sends it. */
  private async read(query: MscQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { bytes } = await fetchBounded(MSC_LOOKUP, { method: 'POST', signal, body: mscRequestBody(query), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      Origin: new URL(MSC_PAGE).origin, Referer: MSC_PAGE, 'User-Agent': MSC_USER_AGENT,
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MSC_MAX_BYTES, fetcher: this.options.fetcher });
    return mscReplyText(decodeText(bytes), query);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new MscTracker({ fetcher: environment.fetcher, executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'msc', recordsSteps: true, steps: ['direct', 'retry', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
