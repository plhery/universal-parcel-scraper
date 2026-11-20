import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import {
  MAX_DETAILS, PROVIDER, WAN_HAI_MAX_BYTES, wanHaiContainerRef, wanHaiJson, wanHaiMoves, wanHaiQuery, wanHaiResult, wanHaiShipment,
  wanHaiUrl, type WanHaiQuery, type WanHaiShipment,
} from './parser.js';

export { containerCheckDigit, wanHaiQuery, wanHaiResult, wanHaiShipment, wanHaiUrl } from './parser.js';
export type { WanHaiQuery } from './parser.js';

// The headers Wan Hai's Android app sends with each request. The key is the same in every copy
// of the app, and the device fields describe no particular device.
export const WAN_HAI_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/json',
  'User-Agent': 'okhttp/4.12.0',
  'x-api-key': 'a6042521-6c7d-ea11-9c40', // gitleaks:allow
  'x-app-version': '2.0.13',
  'x-auto-expriation': '60',
  'x-booking-source': 'Android',
  'x-device-name': 'Android',
  'x-device-type': '60',
  'x-manufacturer-name': 'Android',
  'x-nation-code': 'en',
  'x-system-version': '14',
  'x-token-id': '60',
  'x-uuid': 'android',
};
const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface WanHaiTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class WanHaiTracker {
  constructor(private readonly options: WanHaiTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = wanHaiQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Wan Hai budget must be positive');
    // A request that fails to reach Wan Hai, or hangs, gets one more.
    return runSteps<CarrierResult>({ carrier: 'wan-hai', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /**
   * As the app asks: a bill's B/L screen, or its booking screen before the bill is issued, then
   * the moves of its first containers; a container's screen for the booking of its latest cycle,
   * then its moves under that booking.
   */
  private async read(query: WanHaiQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const get = (url: string) => this.get(url, signal, deadline);
    let shipment: WanHaiShipment | null;
    if (query.kind === 'container') {
      const refNo = wanHaiContainerRef(await get(wanHaiUrl('ctnr-no', { ctnr_no: query.number })), query.number);
      shipment = refNo ? { refNo, zones: new Map(), containers: [{ number: query.number, latest: null }] } : null;
    } else {
      shipment = wanHaiShipment(await get(wanHaiUrl('bl-detail', { ref_no: query.number })), query.number)
        ?? wanHaiShipment(await get(wanHaiUrl('booking-detail', { ref_no: query.number })), query.number);
    }
    const details = new Map<string, ReturnType<typeof wanHaiMoves>>();
    for (const { number } of shipment?.containers.slice(0, MAX_DETAILS) ?? []) {
      details.set(number, wanHaiMoves(await get(wanHaiUrl('movement', { ref_no: shipment!.refNo, ctnr_no: number })), number, shipment!.zones));
    }
    return wanHaiResult(shipment, details);
  }

  private async get(url: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - Date.now())));
    const { bytes } = await fetchBounded(url, { method: 'GET', signal, headers: { ...WAN_HAI_HEADERS } },
      { provider: PROVIDER, timeoutMs, maxBytes: WAN_HAI_MAX_BYTES, fetcher: this.options.fetcher });
    return wanHaiJson(decodeText(bytes));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WanHaiTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'wan-hai', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
