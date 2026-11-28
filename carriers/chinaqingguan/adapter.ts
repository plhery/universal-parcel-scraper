import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ChinaqingguanOcr } from './ocr.js';
import { CARRIER, CHINAQINGGUAN_MAX_BYTES, chinaqingguanRefusedCode, isChallenge, normalizeChinaqingguanNumber, parseChinaqingguan,
  PROVIDER } from './parser.js';

export { chinaqingguanRefusedCode, normalizeChinaqingguanNumber, parseChinaqingguan } from './parser.js';

const ORIGIN = 'http://www.chinaqingguan.com';
/** The search form, sent as the referrer. */
export const CHINAQINGGUAN_PAGE = `${ORIGIN}/cha/index.php?m=Index&a=search`;
/** The verify code picture, which opens the PHP session its code is kept in. */
export const CHINAQINGGUAN_CAPTCHA = `${ORIGIN}/cha/index.php?m=Index&a=code`;
/** Where the form posts the number and the code. */
export const CHINAQINGGUAN_SEARCH = `${ORIGIN}/cha/index.php?m=Index&a=soso`;
const ANSWER = /^\d{4}$/;
// Pictures per lookup. The shared model reads about three in four, so four pictures nearly always do.
const PICTURES = 4;
// Time one more picture needs: the picture, reading it and the search.
const PICTURE_MS = 4_000;
const DEFAULT_BUDGET_MS = 25_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class ChinaqingguanTracker {
  private readonly ocr = new ChinaqingguanOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeChinaqingguanNumber(raw);
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
          headers: { Accept: accept, Referer: CHINAQINGGUAN_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } },
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
          const image = await request(fetcher, CHINAQINGGUAN_CAPTCHA, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          if (isChallenge(decodeText(image))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          // A reading that is not four digits is not sent: a new picture costs less than a refused search.
          if (!ANSWER.test(code)) { unread++; continue; }
          // The page is UTF-8, as its header and its meta tag say.
          const html = decodeText(await request(fetcher, CHINAQINGGUAN_SEARCH, 'text/html,application/xhtml+xml', CHINAQINGGUAN_MAX_BYTES,
            new URLSearchParams({ inputNumber: number, checkcode: code }).toString()));
          if (chinaqingguanRefusedCode(html)) { refused++; continue; }
          return parseChinaqingguan(html, number);
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
  const tracker = new ChinaqingguanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: CARRIER, recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
