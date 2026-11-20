import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import {
  KMTC_API, KMTC_MAX_BYTES, MAX_DETAILS, PROVIDER, kmtcContainers, kmtcDetailUrl, kmtcJson, kmtcMoves, kmtcQuery, kmtcResult, type KmtcQuery,
} from './parser.js';
import { parseKmtcChallenge, solveKmtcChallenge } from './pow.js';

export { kmtcContainers, kmtcDetailUrl, kmtcMoves, kmtcQuery, kmtcResult } from './parser.js';
export type { KmtcContainer, KmtcQuery } from './parser.js';

// KMTC's API sits behind Akamai, which turns away clients that do not name a browser.
export const KMTC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const HEADERS = { Accept: 'application/json, text/plain, */*', Referer: 'https://www.ekmtc.com/', 'User-Agent': KMTC_USER_AGENT };
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface KmtcTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class KmtcTracker {
  constructor(private readonly options: KmtcTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = kmtcQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('KMTC budget must be positive');
    // A request that fails to reach KMTC, or hangs, gets one more.
    return runSteps<CarrierResult>({ carrier: 'kmtc', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs)), budgetMs) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs), budgetMs)),
    ]);
  }

  /** As the page asks: a proof of work, the search for the number's containers, then each container's moves. */
  private async read(query: KmtcQuery, signal: AbortSignal, timeoutMs: number, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const challenge = parseKmtcChallenge(await this.request(`${KMTC_API}/pow/challenge`, {}, signal, deadline));
    const token = await solveKmtcChallenge(challenge, signal, deadline, budgetMs);
    const search = await this.request(`${KMTC_API}/cargo-tracking/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'pow-token': token }, body: JSON.stringify({ dtKnd: query.kind, blNo: query.number }),
    }, signal, deadline);
    const containers = kmtcContainers(search, query);
    const details = new Map<string, ReturnType<typeof kmtcMoves>>();
    for (const container of containers?.slice(0, MAX_DETAILS) ?? []) {
      details.set(container.container, kmtcMoves(await this.request(kmtcDetailUrl(query, container), {}, signal, deadline), container));
    }
    return kmtcResult(containers, details);
  }

  private async request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - performance.now())));
    const { bytes } = await fetchBounded(url, { method: init.method ?? 'GET', signal, headers: { ...HEADERS, ...init.headers }, ...(init.body ? { body: init.body } : {}) },
      { provider: PROVIDER, timeoutMs, maxBytes: KMTC_MAX_BYTES, fetcher: this.options.fetcher });
    return kmtcJson(decodeText(bytes));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new KmtcTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'kmtc', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
