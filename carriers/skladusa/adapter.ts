import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, ChallengeError, SchemaError, TransportError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { assertSkladusaGuestHtml, isSkladusaTrackingRoute, MAX_BYTES, normalizeSkladusaNumber, parseSkladusaTrackingHtml, PROVIDER, skladusaTrackingUrl } from './parser.js';

export class SkladusaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSkladusaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const started = performance.now(), jar = new CookieJar();
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, jar);
      let url = skladusaTrackingUrl(number), totalBytes = 0;
      for (let request = 0; request < 4; request += 1) {
        signal.throwIfAborted();
        const left = Math.floor(timeoutMs - (performance.now() - started));
        if (left < 1) throw new BudgetExceededError(PROVIDER, left);
        if ((await jar.getCookieString(url)).length > 16_384) throw new SchemaError(PROVIDER, 'SkladUSA returned too much guest state');
        let reply: Awaited<ReturnType<typeof fetchBounded>>;
        try {
          reply = await fetchBounded(url, { signal,
            headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9',
              'User-Agent': userAgentOf(this.options.userAgent) },
          }, { provider: PROVIDER, fetcher, timeoutMs: left,
            maxBytes: MAX_BYTES - totalBytes, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 428] });
        } catch (error) {
          signal.throwIfAborted();
          // Guest cookies and whole tracking routes must not enter public error causes or diagnostics.
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
          if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, 'SkladUSA could not read its guest tracker', {
            status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
          throw new TransportError(PROVIDER, 'SkladUSA could not read its guest tracker');
        }
        signal.throwIfAborted();
        const { response, bytes } = reply;
        totalBytes += bytes.byteLength;
        if ([401, 403, 428].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
          throw new ChallengeError(PROVIDER, 'SkladUSA refused public tracking');
        }
        if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'SkladUSA returned another tracking route');
        const html = decodeText(bytes).replace(/^\uFEFF/, '');
        assertSkladusaGuestHtml(html);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          let next: string | undefined;
          try { if (location && location.length <= 512 && location === location.trim()) next = new URL(location, url).href; }
          catch { /* An invalid redirect remains unavailable, never a missing parcel. */ }
          if (!next || !isSkladusaTrackingRoute(next, number)) throw new TransportError(PROVIDER, 'SkladUSA redirected outside its tracking route');
          url = next;
          continue;
        }
        if (response.status !== 200) throw new TransportError(PROVIDER, 'SkladUSA tracking is unavailable', { status: response.status });
        const type = response.headers.get('content-type') ?? '';
        if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new SchemaError(PROVIDER, 'SkladUSA returned no tracking HTML');
        return parseSkladusaTrackingHtml(html, number, url);
      }
      throw new TransportError(PROVIDER, 'SkladUSA exceeded its tracking redirect limit');
    };
    return runSteps({ carrier: 'skladusa', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SkladusaTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'skladusa', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
