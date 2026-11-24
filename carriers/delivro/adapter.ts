import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, DELIVRO_MAX_BYTES, delivroJson, isDelivroBlocked, isDelivroNotFound, normalizeDelivroNumber, parseDelivro, PROVIDER,
} from './parser.js';

export { normalizeDelivroNumber, parseDelivro } from './parser.js';

/** Délivro's host on Dispatch Science, which serves its tracking page and the tracker the page's script asks. */
export const DELIVRO_HOST = 'https://delivro.dsapp.io';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one order id, as the page's script builds it. */
export function delivroLookupUrl(number: string): string {
  return `${DELIVRO_HOST}/api/v1/orders/tracking/${encodeURIComponent(number)}`;
}

/** The tracking page for one order id, which makes the lookup. */
export function delivroPageUrl(number: string): string {
  return `${DELIVRO_HOST}/customer/${encodeURIComponent(number)}`;
}

export class DelivroTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's script sends Angular's Accept and a JSON content type, no token or cookie; the
    // checkpoints come in the language asked, English here.
    const { response, bytes } = await fetchBounded(delivroLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en', 'Content-Type': 'application/json',
      Referer: delivroPageUrl(number), 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DELIVRO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 403 || status === 503) {
      if (isDelivroBlocked(body)) throw new ChallengeError(PROVIDER, 'Délivro answered with a browser check', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Délivro refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if (status === 404 && json) {
      // An order id the tracker holds nothing for gets a 404 and the framework's bare problem
      // document. It does not repeat the id; the stateless request for it does.
      if (isDelivroNotFound(delivroJson(body))) throw new NotFoundError(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'Délivro did not complete the lookup', { status });
    }
    // A redirect, or a 404 without the problem document, as a missing route gives, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Délivro tracking is unavailable', { status });
    if (!json) {
      if (isDelivroBlocked(body)) throw new ChallengeError(PROVIDER, 'Délivro answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Délivro answered with a page instead of its tracking reply');
    }
    return parseDelivro(delivroJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDelivroNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Délivro for its order ids, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DelivroTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
