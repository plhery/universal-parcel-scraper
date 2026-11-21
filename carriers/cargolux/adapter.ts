import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARGOLUX_MAX_BYTES, normalizeCargoluxWaybill, parseCargolux, PROVIDER } from './parser.js';

export { CARGOLUX_PREFIXES, normalizeCargoluxWaybill, parseCargolux } from './parser.js';

/** The tracking service the tracker at cargolux.com names as its `apiUrl`. */
export const CARGOLUX_API = 'https://cargolux-icargo-api-app-prod.politesmoke-46f514de.westeurope.azurecontainerapps.io';
/** The lookup the tracker's script asks, with the waybills it tracks as `numbers`. */
export const cargoluxLookupUrl = (waybill: string): string => `${CARGOLUX_API}/api/track/awbs/?numbers=${encodeURIComponent(waybill)}`;

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
const CHALLENGE = /captcha|challenge|access denied|request blocked|just a moment|attention required/i;

export class CargoluxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(waybill: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(cargoluxLookupUrl(waybill), { signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: CARGOLUX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved service, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Cargolux tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'Cargolux answered with a verification page');
      throw new SchemaError(PROVIDER, 'Cargolux answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Cargolux returned a reply that is not JSON', { cause: error });
    }
    return parseCargolux(payload, waybill);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const waybill = normalizeCargoluxWaybill(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(waybill, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(waybill, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CargoluxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
