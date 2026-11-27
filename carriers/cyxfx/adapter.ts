import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, CYXFX_MAX_BYTES, normalizeCyxfxNumber, notJson, parseCyxfx, PROVIDER } from './parser.js';

export { cyxfxText, normalizeCyxfxNumber, parseCyxfx } from './parser.js';

/** The service the tracking page on cyxfx.com asks. It answers plain HTTP only. */
export const CYXFX_API = 'http://api.2019.cyxfx.cn/api/track/list';
/** The site whose tracking page asks the service. */
export const CYXFX_SITE = 'http://www.cyxfx.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server is sometimes slow to accept a connection from abroad.
const DEFAULT_BUDGET_MS = 20_000;

export class CyxfxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, token or account. The page can ask up to ten numbers at once.
    const { response, bytes } = await fetchBounded(CYXFX_API, { method: 'POST', signal, body: JSON.stringify({ sns: number }), headers: {
      Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/json', Origin: CYXFX_SITE.slice(0, -1),
      Referer: CYXFX_SITE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: CYXFX_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 405, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route or a request the service now refuses.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    const body = decodeText(bytes).replace(/^\uFEFF/, '');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      notJson(body);
    }
    return parseCyxfx(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCyxfxNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CyxfxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCyxfxNumber(number))),
  };
};
