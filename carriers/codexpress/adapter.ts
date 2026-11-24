import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CODEXPRESS_LOOKUP, CODEXPRESS_MAX_BYTES, codexpressJson, isCodexpressBlocked, isCodexpressNotFound, normalizeCodexpressNumber,
  parseCodexpress, PROVIDER,
} from './parser.js';

export { CODEXPRESS_LOOKUP, normalizeCodexpressNumber, parseCodexpress } from './parser.js';

const TRACKER_PAGE = 'https://cbd-tracking.locate2u.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class CodexpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the tracking page's script makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(CODEXPRESS_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ tracking_id: number }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CODEXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 403 || status === 503) {
      if (isCodexpressBlocked(body)) throw new ChallengeError(PROVIDER, 'CODExpress answered with a browser check', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'CODExpress refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if ((status === 400 || status === 404) && json) {
      // A barcode the account does not hold gets HTTP 404 and the tracker's own wording, which does
      // not repeat the barcode; the request for it does. Any other refusal leaves the answer open.
      if (isCodexpressNotFound(codexpressJson(body))) throw new NotFoundError(PROVIDER, 'CODExpress has no parcel under this barcode');
      throw new IndeterminateError(PROVIDER, 'CODExpress did not complete the lookup', { status });
    }
    // A redirect, or a 404 without the tracker's JSON, as a missing route gives, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'CODExpress tracking is unavailable', { status });
    if (!json) {
      if (isCodexpressBlocked(body)) throw new ChallengeError(PROVIDER, 'CODExpress answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'CODExpress answered with a page instead of its tracking reply');
    }
    return parseCodexpress(codexpressJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCodexpressNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers CODExpress for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CodexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
