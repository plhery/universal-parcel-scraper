import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MorelinkOcr } from './ocr.js';
import { CARRIER, isChallenge, MORELINK_MAX_BYTES, morelinkRefusedCode, normalizeMorelinkNumber, parseMorelink, PROVIDER } from './parser.js';

export { morelinkRefusedCode, normalizeMorelinkNumber, parseMorelink } from './parser.js';

const ORIGIN = 'https://client.morelink56.com';
/** The tracking page, sent as the referrer. */
export const morelinkPage = (number: string) => `${ORIGIN}/homepage/order_tracking?strorderno=${encodeURIComponent(number)}`;
/** The verify code picture, which opens the ASP.NET session its code is kept in; the page adds the time to it. */
export const MORELINK_CAPTCHA = `${ORIGIN}/homepage/GetValidateCode`;
/** Where the page posts the number and the code. */
export const MORELINK_SEARCH = `${ORIGIN}/homepage/seeorderdata`;
// Four letters and digits; the tracker takes letters in either case.
const ANSWER = /^[A-Za-z0-9]{4}$/;
// Pictures per lookup. The shared model reads most of them, so four nearly always do.
const PICTURES = 4;
// Time one more picture needs: the picture, reading it and the search.
const PICTURE_MS = 4_000;
const DEFAULT_BUDGET_MS = 25_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class MorelinkTracker {
  private readonly ocr = new MorelinkOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeMorelinkNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      const request = async (fetcher: typeof fetch, url: string, accept: string, maxBytes: number, body?: string) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
          headers: { Accept: accept, Referer: morelinkPage(number), 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, `${PROVIDER} refused its guest request`);
        if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking page moved`, { status: response.status });
        return bytes;
      };
      try {
        let refused = 0, unread = 0;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          // Each picture opens a session of its own, so a session the server dropped is never asked again.
          const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
          const image = await request(fetcher, `${MORELINK_CAPTCHA}?time=${Date.now()}`, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          if (isChallenge(decodeText(image))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          // A reading that is not four letters and digits is not sent: a new picture costs less than a refused search.
          if (!ANSWER.test(code)) { unread++; continue; }
          const text = decodeText(await request(fetcher, MORELINK_SEARCH, 'application/json, text/javascript, */*; q=0.01', MORELINK_MAX_BYTES,
            new URLSearchParams({ ordercode: code, strorderno: number }).toString())).replace(/^\uFEFF/, '');
          if (isChallenge(text)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
          let reply: unknown;
          try { reply = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`); }
          if (morelinkRefusedCode(reply)) { refused++; continue; }
          return parseMorelink(reply, number);
        }
        throw new ChallengeError(PROVIDER, `${PROVIDER} verify code unsolved: ${refused} refused, ${unread} unread`);
      } catch (error) {
        // Raw transport diagnostics can carry the session cookie.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MorelinkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: CARRIER, recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
