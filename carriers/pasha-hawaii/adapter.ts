import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  MAX_DETAILS, PASHA_MAX_BYTES, PASHA_TRACKER, pashaContainer, pashaContainerResult, pashaQuery, pashaSearchForm, pashaShipment, pashaShipmentResult,
  PROVIDER, type PashaMove, type PashaQuery,
} from './parser.js';

export { containerCheckDigit, pashaContainer, pashaContainerResult, pashaQuery, pashaSearchForm, pashaShipment, pashaShipmentResult, PASHA_TRACKER } from './parser.js';
export type { PashaMove, PashaQuery, PashaShipment } from './parser.js';

const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface PashaHawaiiTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class PashaHawaiiTracker {
  constructor(private readonly options: PashaHawaiiTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = pashaQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Pasha Hawaii budget must be positive');
    // A request that fails to reach the tracker, or hangs, gets one more lookup.
    return runSteps<CarrierResult>({ carrier: 'pasha-hawaii', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /** As the tracker's links go: a container's moves; a bill's or booking's containers, then the moves of its first ones. */
  private async read(query: PashaQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const search = (asked: PashaQuery) => this.post(asked, signal, deadline, timeoutMs);
    if (query.kind === 'container') {
      const moves = pashaContainer(await search(query), query.number);
      if (!moves) throw new NotFoundError(PROVIDER, 'Pasha Hawaii does not hold this container');
      return pashaContainerResult(moves);
    }
    const shipment = pashaShipment(await search(query), query);
    if (!shipment) throw new NotFoundError(PROVIDER, 'Pasha Hawaii does not hold this number');
    const details = new Map<string, PashaMove[] | null>();
    for (const { number } of shipment.containers.slice(0, MAX_DETAILS)) {
      details.set(number, pashaContainer(await search({ kind: 'container', number }), number));
    }
    return pashaShipmentResult(shipment, details);
  }

  /**
   * One search, posted as the tracker's form. The tracker answers a number it does not hold in its
   * page, so a redirect or a missing address is the tracker gone, not the parcel.
   */
  private async post(query: PashaQuery, signal: AbortSignal, deadline: number, timeoutMs: number): Promise<string> {
    signal.throwIfAborted();
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new BudgetExceededError(PROVIDER, timeoutMs);
    const { response, bytes } = await fetchBounded(PASHA_TRACKER, { method: 'POST', signal, body: pashaSearchForm(query).toString(), headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.min(REQUEST_LIMIT_MS, left), maxBytes: PASHA_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Pasha Hawaii\'s tracker did not answer', { status: response.status });
    return decodeText(bytes);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PashaHawaiiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'pasha-hawaii', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
