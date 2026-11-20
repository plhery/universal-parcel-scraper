import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import {
  MAX_DETAILS, PROVIDER, YANG_MING_BLOCK_STATUS, YANG_MING_MAX_BYTES, yangMingBlocked, yangMingDetail, yangMingJson,
  yangMingLookup, yangMingLookupUrl, yangMingQuery, yangMingResult, type YangMingQuery,
} from './parser.js';

export { containerCheckDigit, yangMingLookup, yangMingLookupUrl, yangMingQuery, yangMingResult } from './parser.js';
export type { YangMingQuery } from './parser.js';

// Akamai refuses a client that does not name a browser.
export const YANG_MING_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface YangMingTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class YangMingTracker {
  constructor(private readonly options: YangMingTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = yangMingQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Yang Ming budget must be positive');
    // A lookup that fails to reach Yang Ming, or hangs, gets one more.
    return runSteps<CarrierResult>({ carrier: 'yang-ming', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /**
   * The page's search for the number, then, for a bill, the moves of its first containers as the
   * page asks for them. When Yang Ming holds no such number, whether it blocks this address,
   * which it answers the same way.
   */
  private async read(query: YangMingQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const get = (url: string) => this.get(url, signal, deadline);
    const lookup = yangMingLookup(await get(yangMingLookupUrl(query.number)), query);
    if (lookup.kind === 'missing' && yangMingBlocked(await get(YANG_MING_BLOCK_STATUS))) {
      throw new ChallengeError(PROVIDER, 'Yang Ming blocks this address until its picture code is entered');
    }
    const details = new Map<string, ReturnType<typeof yangMingDetail>>();
    if (lookup.kind === 'bill') {
      for (const { number } of lookup.containers.slice(0, MAX_DETAILS)) {
        details.set(number, yangMingDetail(await get(yangMingLookupUrl(number, 'BL_CT', lookup.refNo)), number, lookup.zones));
      }
    }
    return yangMingResult(lookup, details);
  }

  private async get(url: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - Date.now())));
    const { bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: 'https://www.yangming.com/en/ebusiness/cargo_tracking', 'User-Agent': YANG_MING_USER_AGENT,
    } }, { provider: PROVIDER, timeoutMs, maxBytes: YANG_MING_MAX_BYTES, fetcher: this.options.fetcher });
    return yangMingJson(decodeText(bytes));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YangMingTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'yang-ming', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
