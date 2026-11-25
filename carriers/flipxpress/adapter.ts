import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FLIP_LOOKUP, FLIP_MAX_BYTES, flipJson, flipLookupForms, isFlipBlocked, normalizeFlipNumber, parseFlip, PROVIDER } from './parser.js';

export { FLIP_LOOKUP, flipLookupForms, normalizeFlipNumber, parseFlip } from './parser.js';

const SITE = 'https://www.flipxp.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class FlipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The request the tracking page's script makes. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${FLIP_LOOKUP}?${new URLSearchParams({ awb_number: flipLookupForms(number).join(',') })}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FLIP_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isFlipBlocked(body)) throw new ChallengeError(PROVIDER, 'Flip Xpress answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Flip Xpress refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown waybill with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Flip Xpress tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isFlipBlocked(body)) throw new ChallengeError(PROVIDER, 'Flip Xpress answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Flip Xpress answered with a page instead of its tracking reply');
    }
    return parseFlip(flipJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFlipNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: Flip Xpress's waybills follow no documented layout and no detection rule offers
// it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new FlipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
