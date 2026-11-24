import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isPaketBlocked, isPaketNotFound, normalizePaketNumber, PAKET_MAX_BYTES, paketJson, parsePaket, PROVIDER,
} from './parser.js';

export { normalizePaketNumber, parsePaket } from './parser.js';

/** The tracking page, a Flutter app whose script asks the tracker. */
export const PAKET_PAGE = 'https://track.paket.cl/';
const PAKET_ORIGIN = 'https://track.paket.cl';
/** The tracker the page's script asks, Paket's API on Google Cloud Run. */
export const PAKET_TRACK = 'https://paket-api-47404721744.southamerica-west1.run.app/envios/tracking.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one number, as the page's script builds it for a number typed in. */
export function paketLookupUrl(number: string): string {
  return `${PAKET_TRACK}?${new URLSearchParams({ id: number })}`;
}

export class PaketTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's request comes from its origin; it sends no token, cookie or header of its own.
    const { response, bytes } = await fetchBounded(paketLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', Origin: PAKET_ORIGIN, Referer: PAKET_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PAKET_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404] });
    const { status } = response;
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (isPaketBlocked(body)) throw new ChallengeError(PROVIDER, 'Paket answered with a browser check', { status });
      // A redirect or a 404 page is a moved tracker; a page with HTTP 200 a changed reply.
      if (status !== 200) throw new TransportError(PROVIDER, 'Paket tracking is unavailable', { status });
      throw new SchemaError(PROVIDER, 'Paket answered with a page instead of its tracking reply');
    }
    if (status === 404) {
      // The tracker answers a number it holds nothing for with a 404 and its message, which the
      // page reads as not found. It does not repeat the number; the stateless request for it does.
      if (isPaketNotFound(paketJson(body))) throw new NotFoundError(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'Paket did not complete the lookup', { status });
    }
    if (status !== 200) throw new TransportError(PROVIDER, 'Paket tracking is unavailable', { status });
    return parsePaket(paketJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePaketNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: Paket's four to twelve digits are a shape many carriers share,
// and no detection rule offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new PaketTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
