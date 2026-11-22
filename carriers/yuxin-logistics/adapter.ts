import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { YuxinOcr } from './ocr.js';
import { normalizeYuxinNumber, parseYuxin, PROVIDER, YUXIN_CAPTCHA, YUXIN_ENDPOINT, YUXIN_PAGE, YUXIN_REFUSED, yuxinJson } from './parser.js';

export { parseYuxin } from './parser.js';
const ANSWER = /^[A-Z0-9]{4}$/;
// Pictures per lookup. The shared model reads most of them, and the tracker counts each answer
// towards its limit on quick lookups, so a few pictures are enough.
const PICTURES = 3;
// Time one more picture needs: the picture, reading it and the lookup.
const PICTURE_MS = 4_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class YuxinTracker {
  private readonly ocr = new YuxinOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYuxinNumber(raw);
    return runSteps({ carrier: 'yuxin-logistics', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // The picture's code lives in the session the picture opens.
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (url: string, accept: string, maxBytes: number, body?: string) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
          headers: { Accept: accept, Referer: YUXIN_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Yuxin Logistics refused its guest request');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Yuxin Logistics tracking endpoint moved', { status: response.status });
        return bytes;
      };
      try {
        let refused = false;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const image = await request(`${YUXIN_CAPTCHA}?pic_id=&${picture + 1}`, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          // A reading that is not four capitals or digits is not sent: a new picture costs less than a refused lookup.
          if (!ANSWER.test(code)) continue;
          const reply = yuxinJson(decodeText(await request(YUXIN_ENDPOINT, 'application/json, text/javascript, */*; q=0.01', 2_000_000,
            new URLSearchParams({ orders: number, req_pic_key: code }).toString())));
          try {
            return parseYuxin(reply, number);
          } catch (error) {
            if (!(error instanceof ChallengeError) || error.message !== YUXIN_REFUSED) throw error;
            refused = true;
          }
        }
        throw new ChallengeError(PROVIDER, refused ? 'Yuxin Logistics refused every captcha answer' : 'Yuxin Logistics captcha pictures could not be read');
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
  const tracker = new YuxinTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yuxin-logistics', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
