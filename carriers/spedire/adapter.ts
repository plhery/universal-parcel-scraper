import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpedireNumber, parseSpedire, PROVIDER, SPEDIRE_MAX_BYTES, spedireShipment } from './parser.js';

export { normalizeSpedireNumber, parseSpedire } from './parser.js';

/**
 * The lookups the tracker page at spedire.com/tracking/{code} calls, in its order: spedire pro's
 * first, then spedire's own. Cloudflare challenges the page but not these.
 */
export const SPEDIRE_LOOKUPS = ['https://www.spedirepro.com/api/public/tracking', 'https://www.spedire.com/api/public/tracking'] as const;
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class SpedireTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async lookup(url: string, number: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ code: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
      maxBytes: SPEDIRE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved lookup, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Spedire tracking moved', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'Spedire answered with a page instead of its tracking reply');
    }
    try {
      return JSON.parse(decodeText(bytes));
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Spedire returned a reply that is not JSON', { cause: error });
    }
  }

  // A code names a shipment on one platform; the other answers `{"success":false}`.
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    for (const url of SPEDIRE_LOOKUPS) {
      const payload = await this.lookup(url, number, signal, deadline);
      if (spedireShipment(payload)) return parseSpedire(payload, number);
    }
    throw new NotFoundError(PROVIDER, 'Spedire has no shipment under this code');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpedireNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpedireTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
