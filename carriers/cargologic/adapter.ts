import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARGOLOGIC_MAX_BYTES, normalizeCargologicWaybill, parseCargologic, parseCargologicError, PROVIDER } from './parser.js';

export { normalizeCargologicWaybill, parseCargologic, parseCargologicError } from './parser.js';

/** The service the tracking component on cargologic.com asks. */
export const CARGOLOGIC_API = 'https://www.cargologic.com/.servlet/tracking/1.0/';
/** The lookup as the page sends it, the waybill formatted as its search box writes it. */
export const cargologicLookupUrl = (waybill: string): string => `${CARGOLOGIC_API}?${new URLSearchParams({ awb: waybill })}`;

const REDIRECTS = [301, 302, 303, 307, 308];
// The service's answers: a bad format, an unknown waybill and a transit shipment it does not show.
const ANSWERS = [400, 404, 451];
const DEFAULT_BUDGET_MS = 20_000;
const CHALLENGE = /captcha|challenge|access denied|request blocked|just a moment|attention required/i;

export class CargologicTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(waybill: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(cargologicLookupUrl(waybill), { signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: CARGOLOGIC_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...ANSWERS] });
    // A redirect is a moved service, not a missing shipment.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Cargologic tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'Cargologic answered with a verification page');
      throw new SchemaError(PROVIDER, 'Cargologic answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Cargologic returned a reply that is not JSON', { cause: error });
    }
    if (response.status !== 200) parseCargologicError(response.status, payload, waybill);
    return parseCargologic(payload);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const waybill = normalizeCargologicWaybill(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(waybill, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(waybill, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CargologicTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
