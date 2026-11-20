import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DANX_MAX_BYTES, danxRows, normalizeDanxNumber, parseDanx, PROVIDER } from './parser.js';

export { normalizeDanxNumber, parseDanx } from './parser.js';

/** The page the tracking form at login.danx.com sends a number to, as `?id=` and the number in base64. */
export const DANX_TRACKER = 'https://fasttrack.danx.com/';
/** The service that page's table asks, with the page's own address as its `id`. */
export const DANX_LOOKUP = 'https://fasttrack.danx.com/FastTrackService.asmx/GetShipmentDetails';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The tracker page's address for a number. */
export const danxTrackerUrl = (number: string): string => `${DANX_TRACKER}?id=${encodeURIComponent(btoa(number))}`;

export class DanxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's script appends its own address to the service's as it stands, without encoding it again.
    const url = `${DANX_LOOKUP}?id=${danxTrackerUrl(number)}&sEcho=1`;
    // The service answers JSON only to a request that says it sends JSON, as the page's script does.
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: DANX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved service, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'DANX tracking moved', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'DANX answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decodeText(bytes));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'DANX returned a reply that is not JSON', { cause: error });
    }
    if (danxRows(payload).length === 0) throw new NotFoundError(PROVIDER, 'DANX has no shipment under this number');
    return parseDanx(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDanxNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DanxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
