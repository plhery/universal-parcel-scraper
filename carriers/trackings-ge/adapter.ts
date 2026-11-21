import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTrackingsGe, PROVIDER, readFormToken, TRACK_URL, trackingsGeNumber } from './parser.js';

const carrier = 'trackings-ge';

export const adapter: AdapterFactory = (environment) => {
  /** The tracker page, for its session cookie and form token, then the lookup its form posts there. */
  async function read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
    const userAgent = userAgentOf(environment.userAgent);
    const request = async (init: RequestInit): Promise<string> => {
      try {
        const { bytes } = await fetchBounded(TRACK_URL, { ...init, signal }, {
          provider: PROVIDER, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          maxBytes: 512 * 1024, redirect: 'manual',
        });
        return decodeText(bytes);
      } catch (error) {
        // The lookup answers a missing parcel in its JSON body, so a missing page is the site's fault.
        if (error instanceof UpstreamHttpError && error.kind === 'not_found') {
          throw new TransportError(PROVIDER, 'The Trackings.GE tracker is unavailable', { status: error.status });
        }
        // Without the request's diagnostics, which hold the session cookie and the form token.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    };

    const token = readFormToken(await request({
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
    }));
    signal.throwIfAborted();
    const reply = await request({
      method: 'POST',
      headers: {
        'User-Agent': userAgent, Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-TOKEN': token,
        'X-Requested-With': 'XMLHttpRequest', Origin: 'https://trackings.ge', Referer: TRACK_URL,
      },
      body: new URLSearchParams({ track_num: number }),
    });
    return parseTrackingsGe(reply, number);
  }

  return {
    id: carrier, recordsSteps: true, steps: ['direct'],
    async track(input, context = {}) {
      const number = trackingsGeNumber(input.number);
      // The tracker takes many seconds over each lookup, found or not, so the one read gets the
      // whole budget: half of it, as a retry would leave the first, is often too little.
      return runSteps({
        carrier, budgetMs: context.budgetMs ?? 40_000, signal: context.signal, recorder: environment.recorder,
      }, [{ id: 'direct', run: ({ signal, remainingMs }) => read(number, signal, remainingMs) }]);
    },
  };
};
