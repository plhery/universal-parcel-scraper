import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DER_KURIER_MAX_BYTES, derKurierGlsForm, normalizeDerKurierNumber, parseDerKurier, PROVIDER, readDerKurierOrderFind } from './parser.js';

export { derKurierGlsForm, normalizeDerKurierNumber, parseDerKurier, readDerKurierOrderFind } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const HTML_TYPE = /^text\/html\b/i;
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The tracker's page for one parcel number, which it renders on the server and keeps for years. */
export const derKurierTrackerUrl = (number: string): string =>
  `https://leotrace.derkurier.de/paketstatus.aspx?${new URLSearchParams({ Lang: 'DE', parcel: number })}`;

/** The order lookup derkurier.de's tracking widget makes first, with the archive included. */
export const derKurierOrderFindUrl = (number: string): string =>
  `https://api.derkurier.de/rs/api/v1/order/find?${new URLSearchParams({ 'parcel-no': number, archive: 'true' })}`;

export class DerKurierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async page(number: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(derKurierTrackerUrl(number), { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DER_KURIER_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 503] });
    const body = decodeText(bytes);
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'DER KURIER refused the lookup', { status: 403 });
    if (response.status === 503) throw new MaintenanceError(PROVIDER, undefined, { status: 503 });
    // A redirect is a moved tracker, not a missing parcel.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'DER KURIER moved its tracking page', { status: response.status });
    if (!HTML_TYPE.test(response.headers.get('content-type') ?? '')) throw new SchemaError(PROVIDER, 'DER KURIER answered with something other than its tracking page');
    return body;
  }

  private async order(number: string, signal: AbortSignal, timeoutMs: number): Promise<'none' | 'listed'> {
    const { response, bytes } = await fetchBounded(derKurierOrderFindUrl(number), { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DER_KURIER_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [404] });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new SchemaError(PROVIDER, 'DER KURIER’s order service answered with a page');
    return readDerKurierOrderFind(response.status, decodeText(bytes), number);
  }

  /**
   * The tracker's page; when it lists neither the number nor its GLS form, the order service the
   * widget asks decides: its answer that it holds no order under either is not found, an order
   * without a row is a parcel listed before its first scan.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const ends = Date.now() + timeoutMs;
    const left = () => ends - Date.now();
    const result = parseDerKurier(await this.page(number, signal, left()), number);
    if (result) return result;
    const gls = derKurierGlsForm(number);
    for (const asked of gls === number ? [number] : [number, gls]) {
      if (await this.order(asked, signal, left()) === 'listed') {
        throw new NoHistoryError(PROVIDER, 'DER KURIER holds an order under the number without a scan', { reason: 'listed' });
      }
    }
    throw new NotFoundError(PROVIDER, 'DER KURIER holds no order under this number');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDerKurierNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: eleven digits are a shape many carriers share and no detection rule offers
// DER KURIER, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DerKurierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
