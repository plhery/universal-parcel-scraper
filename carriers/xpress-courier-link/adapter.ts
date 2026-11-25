import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep, withNetworkRetry } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ECL_MAX_BYTES, eclTrackingUrl, type EclService, isEclBlocked, normalizeEclNumber, parseEcl, PROVIDER } from './parser.js';

export { ECL_TRACKER, eclTrackingUrl, normalizeEclNumber, parseEcl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const HTML_TYPE = /^text\/html\b/i;
const DEFAULT_BUDGET_MS = 20_000;

export class EclTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The tracking page for the number under one service, as its form opens it. No session, key or CAPTCHA. */
  private async read(number: string, service: EclService, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(eclTrackingUrl(number, service), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ECL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isEclBlocked(body)) throw new ChallengeError(PROVIDER, 'ECL answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'ECL refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The page answers an unknown number with HTTP 200; a redirect or a missing page is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'ECL tracking is unavailable', { status });
    if (!HTML_TYPE.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'ECL answered with something other than its tracking page');
    }
    return parseEcl(body, number, service);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEclNumber(raw);
    // The international service first, the form's default: a read that fails to reach ECL, or
    // hangs, is sent once more, the first try getting half of the budget. A number it does not know
    // is asked of the domestic service, which gets one more try the same way.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, 'International', signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, 'International', signal, remainingMs)),
      { id: 'domestic', recovers: (error) => error instanceof NotFoundError,
        run: ({ signal, remainingMs }) => {
          const deadline = performance.now() + remainingMs;
          return withNetworkRetry({ signal, remainingMs: () => deadline - performance.now() },
            (timeoutMs) => this.read(number, 'Domestic', signal, timeoutMs));
        } },
    ]);
  }
}

// No recognition: ECL's numbers are bare digit runs many carriers share and no detection rule
// offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new EclTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry', 'domestic'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
