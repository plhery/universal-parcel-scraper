import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { PadtfOcr } from './ocr.js';
import { normalizePadtfNumber, PADTF_CAPTCHA, PADTF_PAGE, padtfRefusedCaptcha, parsePadtf, PROVIDER } from './parser.js';

export { parsePadtf } from './parser.js';
const ANSWER = /^[A-Z0-9]{4}$/;
// Pictures per lookup. The shared model reads most of them; a wrong answer costs the picture.
const PICTURES = 4;
// Time one more picture needs: the picture, reading it and the lookup.
const PICTURE_MS = 4_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class PadtfTracker {
  private readonly ocr = new PadtfOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePadtfNumber(raw);
    return runSteps({ carrier: 'padtf', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // The picture's code lives in the PHP session the picture opens; the picture is refused
      // without the tracking page as referrer.
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (url: string, accept: string, maxBytes: number, body?: string) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
          headers: { Accept: accept, Referer: PADTF_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'PAD Express refused its guest request');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'PAD Express tracking page moved', { status: response.status });
        return bytes;
      };
      try {
        let refused = false;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const image = await request(`${PADTF_CAPTCHA}?${picture + 1}`, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          // A reading that is not four capitals or digits is not sent: a new picture costs less than a refused lookup.
          if (!ANSWER.test(code)) continue;
          const html = decodeText(await request(PADTF_PAGE, 'text/html,application/xhtml+xml', 1_000_000,
            new URLSearchParams({ seark: number, user_yzm: code }).toString()));
          if (padtfRefusedCaptcha(html)) { refused = true; continue; }
          return parsePadtf(html, number);
        }
        throw new ChallengeError(PROVIDER, refused ? 'PAD Express refused every captcha answer' : 'PAD Express captcha pictures could not be read');
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

export const adapter: AdapterFactory = environment => {
  const tracker = new PadtfTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'padtf', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
