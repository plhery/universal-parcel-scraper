import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NoHistoryError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPD_CN_MAX_BYTES, normalizeDpdCnNumber, parseDpdCnReply, PROVIDER } from './parser.js';

export { dpdCnPlace, normalizeDpdCnNumber, parseDpdCn, parseDpdCnReply, withoutContacts } from './parser.js';

/** The tracking service of the tracker on tracking.dpd.cn, which Lenton Group's other trackers share. */
export const DPD_CN_API = 'https://apitracking.hub-ez.com/api/services/app/tracking/GetTrackingNew';
/** DPD China's tracker, whose host picks its branding. */
export const DPD_CN_PAGE = 'https://tracking.dpd.cn';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/**
 * The request body the tracker's script sends: `para` is JSON text naming the number and `H`, the
 * tracking-number search. `C` would search shippers' references instead.
 */
export const dpdCnRequestBody = (number: string): string =>
  JSON.stringify({ para: JSON.stringify({ trackingNumber: number, hawbType: 'H' }) });

export class DpdCnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(DPD_CN_API, { method: 'POST', signal, body: dpdCnRequestBody(number), headers: {
      // What the tracker's page sends from the browser; the service asks for no cookie or token.
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=utf-8',
      Origin: DPD_CN_PAGE, Referer: `${DPD_CN_PAGE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DPD_CN_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] })
      // A request the caller cancelled ends with the caller's reason.
      .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
    signal.throwIfAborted();
    // An unknown number is HTTP 200 too; a redirect or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'DPD China tracking service moved', { status: response.status });
    return parseDpdCnReply(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDpdCnNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdCnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Known on scans for the number, unknown on its NotFound row. The service serves Lenton Group's other
    // operations too, so a row without scans does not show that DPD China holds the parcel.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeDpdCnNumber(number)),
      { inconclusive: (error) => error instanceof NoHistoryError }),
  };
};
