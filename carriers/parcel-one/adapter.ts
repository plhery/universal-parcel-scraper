import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isParcelOneBlocked, normalizeParcelOneNumber, PARCEL_ONE_MAX_BYTES, parcelOneJson, parseParcelOne, PROVIDER,
} from './parser.js';

export { normalizeParcelOneNumber, parseParcelOne } from './parser.js';

/** The tracking page, which holds the form and the script that asks the tracker. */
export const PARCEL_ONE_PAGE = 'https://parcel.one/en/tracking-en/';
/** The tracker the page's script asks, a WordPress route in front of PARCEL.ONE's tracking service. */
export const PARCEL_ONE_TRACK = 'https://parcel.one/wp-json/parcelone/v1/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/**
 * The tracker's address for one number, as the page's script builds it: the
 * number, the postcode field, which the adapter leaves empty as the page does
 * without one, and English.
 */
export function parcelOneLookupUrl(number: string): string {
  return `${PARCEL_ONE_TRACK}?${new URLSearchParams({ trackno: number, zip: '', lang: 'en' })}`;
}

export class ParcelOneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(parcelOneLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', Referer: PARCEL_ONE_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PARCEL_ONE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 403 || status === 503) {
      if (response.headers.get('cf-mitigated') === 'challenge' || isParcelOneBlocked(body)) {
        throw new ChallengeError(PROVIDER, 'PARCEL.ONE answered with a browser check', { status });
      }
      if (status === 403) throw new ChallengeError(PROVIDER, 'PARCEL.ONE refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'PARCEL.ONE tracking is unavailable', { status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (isParcelOneBlocked(body)) throw new ChallengeError(PROVIDER, 'PARCEL.ONE answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'PARCEL.ONE answered with a page instead of its tracking reply');
    }
    return parseParcelOne(parcelOneJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeParcelOneNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: PARCEL.ONE's thirteen digits are a shape many carriers share,
// and no detection rule offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new ParcelOneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
