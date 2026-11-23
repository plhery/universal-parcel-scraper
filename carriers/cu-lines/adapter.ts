import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CU_LINES_API, CU_LINES_MAX_BYTES, cuLinesCycles, cuLinesJson, cuLinesLatestCycle, cuLinesMoves, cuLinesQuery, cuLinesResult, cuLinesShipment,
  MAX_DETAILS, PROVIDER, type CuLinesForm, type CuLinesQuery, type CuLinesShipment,
} from './parser.js';

export { containerCheckDigit, cuLinesQuery, cuLinesResult, cuLinesShipment, CU_LINES_API } from './parser.js';
export type { CuLinesForm, CuLinesQuery } from './parser.js';

const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface CuLinesTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class CuLinesTracker {
  constructor(private readonly options: CuLinesTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = cuLinesQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('CU Lines budget must be positive');
    // A request that fails to reach CU Lines, or hangs, gets one more.
    return runSteps<CarrierResult>({ carrier: 'cu-lines', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /**
   * As the tracking page asks: a booking's containers, then the moves of its first ones; a
   * container's bookings, then its moves in its latest cycle.
   */
  private async read(query: CuLinesQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const post = (form: CuLinesForm) => this.post(form, signal, deadline);
    let shipment: CuLinesShipment | null;
    if (query.kind === 'container') {
      const cycles = cuLinesCycles(await post({ f_cmd: '122', cntr_no: query.number }));
      if (!cycles) throw new NotFoundError(PROVIDER, 'CU Lines does not hold this container');
      const cycle = cycles.length === 1 ? cycles[0]!
        : cuLinesLatestCycle(await post({ f_cmd: '121', search_type: 'C', search_name: query.number }), query.number, cycles);
      shipment = { containers: [{ number: query.number, ...cycle, latest: null }], more: false };
    } else {
      shipment = cuLinesShipment(await post({ f_cmd: '121', search_type: 'B', search_name: query.number }), query.number);
    }
    const details = new Map<string, ReturnType<typeof cuLinesMoves>>();
    for (const { number, bkgNo, copNo } of shipment?.containers.slice(0, MAX_DETAILS) ?? []) {
      details.set(number, cuLinesMoves(await post({ f_cmd: '125', cntr_no: number, bkg_no: bkgNo, cop_no: copNo }), copNo));
    }
    return cuLinesResult(shipment, details);
  }

  /**
   * One command of the eService, posted as the tracking page's form. CU Lines answers a number it
   * does not hold in the reply itself, so a missing address is the service gone, not the parcel.
   */
  private async post(form: CuLinesForm, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - Date.now())));
    const { response, bytes } = await fetchBounded(CU_LINES_API, { method: 'POST', signal, body: new URLSearchParams(form).toString(), headers: {
      Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: CU_LINES_MAX_BYTES, fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
    if (!response.ok) throw new TransportError(PROVIDER, 'CU Lines tracking service is unavailable', { status: response.status });
    return cuLinesJson(decodeText(bytes));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CuLinesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'cu-lines', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
