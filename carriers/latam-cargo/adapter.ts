import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isLatamBlocked, isLatamNotFound, LATAM_DOCUMENT_TYPES, LATAM_LOOKUP, LATAM_MAX_BYTES, normalizeLatamNumber, parseLatam, PROVIDER,
  type LatamDocumentType, type LatamWaybill,
} from './parser.js';

export { LATAM_LOOKUP, normalizeLatamNumber, parseLatam } from './parser.js';

const TRACKER_PAGE = 'https://www.latamcargo.com/en/trackshipment';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class LatamCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The page's read for one document type, or null when the lookup says it knows no such document. */
  private async lookup(waybill: LatamWaybill, type: LatamDocumentType, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult | null> {
    const body = JSON.stringify({ cargoTrackingRequestSOs: [{ documentPrefix: waybill.prefix, documentNumber: waybill.serial, documentType: type }] });
    const { response, bytes } = await fetchBounded(LATAM_LOOKUP, { method: 'POST', body, signal, headers: {
      Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.latamcargo.com', Referer: `${TRACKER_PAGE}?docNumber=${waybill.serial}&docPrefix=${waybill.prefix}&soType=${type}`,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LATAM_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 429, 503],
    });
    const { status } = response;
    // The page is served in ISO-8859-1, as its header says.
    const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'iso-8859-1';
    const html = decodeText(bytes, charset);
    if (status === 429) throw new RateLimitedError(PROVIDER, undefined, 'LATAM Cargo limited the lookups', { status });
    if (status === 403 || isLatamBlocked(html)) throw new ChallengeError(PROVIDER, 'LATAM Cargo answered with a browser check', { status });
    if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
    if (status !== 200) throw new TransportError(PROVIDER, 'LATAM Cargo tracking is unavailable', { status });
    if (isLatamNotFound(html)) return null;
    if (!html.includes('id="statusTable"') && !html.includes('id="nav-tracking"')) {
      throw new SchemaError(PROVIDER, 'LATAM Cargo answered with a page instead of its tracking reply');
    }
    return parseLatam(html, waybill.label);
  }

  /** International air waybills first, then domestic service orders: each type only finds its own documents. */
  private async read(waybill: LatamWaybill, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const started = Date.now();
    for (const [index, type] of LATAM_DOCUMENT_TYPES.entries()) {
      const left = timeoutMs - (Date.now() - started);
      const share = index === LATAM_DOCUMENT_TYPES.length - 1 ? left : left / 2;
      const result = await this.lookup(waybill, type, signal, share);
      if (result) return result;
    }
    throw new NotFoundError(PROVIDER, 'LATAM Cargo has no air waybill or service order under this number');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const waybill = normalizeLatamNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(waybill, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(waybill, signal, remainingMs)),
    ]);
  }
}

// No recognition: air waybills get no detection rule, so preflight never asks LATAM Cargo.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new LatamCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
