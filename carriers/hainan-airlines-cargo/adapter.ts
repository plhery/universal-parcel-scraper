import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HainanCargoOcr } from './ocr.js';
import { HAINAN_CARGO_MAX_BYTES, HAINAN_CARGO_REFUSED, hainanCargoFormNumber, normalizeHainanCargoNumber, parseHainanCargo, PROVIDER } from './parser.js';

export { normalizeHainanCargoNumber, parseHainanCargo } from './parser.js';

const ORIGIN = 'https://www.hnacargo.com';
/** The tracking page; the home page's waybill box posts to it. */
export const HAINAN_CARGO_PAGE = `${ORIGIN}/Portal2/AwbSearch.aspx`;
/** The verify code picture for the waybill box, kept in the session it opens. */
export const HAINAN_CARGO_CAPTCHA = `${ORIGIN}/VerifyCode.aspx?s=tracking`;
const ANSWER = /^[A-Z]{4}$/;
// Pictures per lookup. The shared model reads most of them, so a few are enough.
const PICTURES = 3;
// Time one more picture needs: the picture, reading it and the lookup.
const PICTURE_MS = 4_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class HainanCargoTracker {
  private readonly ocr = new HainanCargoOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHainanCargoNumber(raw);
    return runSteps({ carrier: 'hainan-airlines-cargo', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // The picture's code lives in the session the picture opens. The page's operations are
      // read in Chinese, the language its status records are in.
      const jar = new CookieJar();
      await jar.setCookie('Language=zh-CN', `${ORIGIN}/`);
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, jar);
      const request = async (url: string, accept: string, maxBytes: number, body?: string) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
          headers: { Accept: accept, Referer: `${ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Hainan Airlines Cargo refused its guest request');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Hainan Airlines Cargo tracking page moved', { status: response.status });
        return bytes;
      };
      try {
        let refused = false;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const image = await request(picture ? `${HAINAN_CARGO_CAPTCHA}&r=${picture}` : HAINAN_CARGO_CAPTCHA, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          // A reading that is not four letters is not sent: a new picture costs less than a refused lookup.
          if (!ANSWER.test(code)) continue;
          const page = decodeText(await request(HAINAN_CARGO_PAGE, 'text/html,application/xhtml+xml', HAINAN_CARGO_MAX_BYTES,
            new URLSearchParams({ hdAwbCode: hainanCargoFormNumber(number), hdVerifyCode: code }).toString()));
          try {
            return parseHainanCargo(page, number);
          } catch (error) {
            if (!(error instanceof ChallengeError) || error.message !== HAINAN_CARGO_REFUSED) throw error;
            refused = true;
          }
        }
        throw new ChallengeError(PROVIDER, refused ? 'Hainan Airlines Cargo refused every verify code' : 'Hainan Airlines Cargo verify codes could not be read');
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
  const tracker = new HainanCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'hainan-airlines-cargo', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
