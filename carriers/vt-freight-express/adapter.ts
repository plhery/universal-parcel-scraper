import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, normalizeVtFreightExpressNumber, parseVtFreightExpress, PORTAL, PROVIDER, VT_FREIGHT_EXPRESS_MAX_BYTES,
} from './parser.js';

export { normalizeVtFreightExpressNumber, parseVtFreightExpress } from './parser.js';

/** VT Freight Express's public tracker on its consignment software. */
export const VT_FREIGHT_EXPRESS_TRACKER = `https://portal.vtfe.com.au/Track/${PORTAL}/`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers every number with HTTP 200: a missing route is not a missing consignment.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one consignment, as its search box builds it. */
export function vtFreightExpressLookupUrl(number: string): string {
  return `${VT_FREIGHT_EXPRESS_TRACKER}${encodeURIComponent(number)}`;
}

export class VtFreightExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(vtFreightExpressLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: VT_FREIGHT_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const { status } = response;
    if (status === 403) throw new ChallengeError(PROVIDER, 'VT Freight Express refused the lookup', { status });
    if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'VT Freight Express tracker is unavailable', { status });
    return parseVtFreightExpress(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeVtFreightExpressNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: the tracker's answer for a number it has no consignment for
// is inconclusive, and the sender prefixes name senders, so no rule offers it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new VtFreightExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
