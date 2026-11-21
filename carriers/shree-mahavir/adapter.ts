import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isMahavirChallenge, MAHAVIR_FORM, MAHAVIR_MAX_BYTES, mahavirDetailUrl, mahavirLookupFields, mahavirRedirected, normalizeMahavirNumber,
  parseMahavir, PROVIDER,
} from './parser.js';

export { MAHAVIR_DETAIL, MAHAVIR_FORM } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/**
 * The same failure without the request details fetchBounded attaches: the
 * tracking detail's address carries the encrypted number, which opens the
 * consignment's page.
 */
function withoutRequest(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class MahavirTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMahavirNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'shree-mahavir', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /**
   * The home page's tracking form, its post back with the number, and the
   * tracking detail the answer points to. None needs a cookie, a captcha or a
   * browser.
   */
  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const send = (url: string, init: RequestInit & { headers?: Record<string, string> }) => fetchBounded(url, {
      ...init, signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent, ...init.headers },
    }, { provider: PROVIDER, timeoutMs: left(), maxBytes: MAHAVIR_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const page = (response: Response, bytes: Uint8Array, what: string): string => {
      const body = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isMahavirChallenge(body) ? `Shree Mahavir answered its ${what} with a browser check`
          : `Shree Mahavir refused its ${what}`, { status: 403 });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, `Shree Mahavir's ${what} is unavailable`);
      return body;
    };
    try {
      const home = await send(MAHAVIR_FORM, { method: 'GET' });
      if (REDIRECTS.includes(home.response.status)) mahavirRedirected(home.response.headers.get('location'), 'tracking form');
      const fields = mahavirLookupFields(page(home.response, home.bytes, 'tracking form'), number);
      signal.throwIfAborted();
      const lookup = await send(MAHAVIR_FORM, { method: 'POST', body: fields.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!REDIRECTS.includes(lookup.response.status)) {
        const body = page(lookup.response, lookup.bytes, 'tracking lookup');
        if (isMahavirChallenge(body)) throw new ChallengeError(PROVIDER, 'Shree Mahavir answered with a browser check');
        // The form answers a post it does not take with the home page again.
        throw new SchemaError(PROVIDER, 'Shree Mahavir did not take the tracking lookup');
      }
      const url = mahavirDetailUrl(lookup.response.headers.get('location'));
      signal.throwIfAborted();
      const detail = await send(url, { method: 'GET' });
      if (REDIRECTS.includes(detail.response.status)) mahavirRedirected(detail.response.headers.get('location'), 'tracking detail');
      return parseMahavir(page(detail.response, detail.bytes, 'tracking detail'), number);
    } catch (error) {
      throw withoutRequest(error);
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MahavirTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shree-mahavir', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMahavirNumber(number))),
  };
};
