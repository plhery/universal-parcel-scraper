import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { fetchCoscoInBrowser } from './browser.js';
import { COSCO_CONTAINERS, COSCO_DETAIL, COSCO_MAX_BYTES, COSCO_ORIGIN, coscoBillResult, coscoContainerResult, coscoPageUrl, coscoQuery,
  coscoRequestBody, PROVIDER } from './parser.js';

export { coscoBillResult, coscoContainerResult, coscoQuery, decodeCoscoReply } from './parser.js';

const DEFAULT_BUDGET_MS = 45_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export interface CoscoTrackerOptions {
  fetcher?: typeof fetch;
  userAgent?: string;
  recorder?: StepRecorder;
  /** A local Chromium, which passes the bot manager when it blocks plain requests. */
  executablePath?: string | null;
}

export class CoscoShippingLinesTracker {
  constructor(private readonly options: CoscoTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = coscoQuery(raw);
    const executablePath = this.options.executablePath ?? null;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own lookup, with the headers its script sends.
      const { response, bytes } = await fetchBounded(query.kind === 'container' ? COSCO_CONTAINERS : COSCO_DETAIL, { method: 'POST', signal,
        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: COSCO_ORIGIN,
          Referer: coscoPageUrl(query), 'User-Agent': userAgentOf(this.options.userAgent) }, body: coscoRequestBody(query) },
      { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COSCO_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE] });
      signal.throwIfAborted();
      // A moved or missing endpoint is a changed tracker, not a missing shipment.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'COSCO\'s cargo tracking lookup is unavailable', { status: response.status });
      const body = decodeText(bytes);
      return query.kind === 'container' ? coscoContainerResult(body, query.number) : coscoBillResult(body, query.number);
    };
    // The bot manager in front of the lookup blocks a plain client for a few minutes after a
    // handful of requests; a browser passes its check.
    return runSteps<CarrierResult>({ carrier: 'cosco-shipping-lines', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
      { id: 'browser', enabled: Boolean(executablePath), recovers: error => ['challenge', 'rate_limited'].includes(carrierErrorKind(error) ?? ''),
        run: ({ signal, remainingMs }) => fetchCoscoInBrowser(query, executablePath!, signal, Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CoscoShippingLinesTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder,
    executablePath: environment.browserExecutablePath });
  return { id: 'cosco-shipping-lines', recordsSteps: true, steps: ['direct', 'retry', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
