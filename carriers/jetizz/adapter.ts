import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { paused } from '../../core/runner/pause.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { botDetectAnswer, botDetectInstance } from '../../core/transport/botdetect.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JetizzOcr } from './ocr.js';
import { isJetizzNumber, parseJetizz, PROVIDER } from './parser.js';

export { parseJetizz } from './parser.js';
const ORIGIN = 'https://app.jetizz.com';
const PAGE = `${ORIGIN}/gonderi-takip`;
const CAPTCHA = 'ExampleCaptcha';
const ANSWER = /^[A-Z0-9]{4}$/;
// Pictures per lookup. The shared model reads most of them; a wrong answer costs the picture,
// and a new one costs the page and the picture.
const PICTURES = 5;
// Time one more picture needs: the page, the picture, reading it, the wait and the lookup.
const PICTURE_MS = 5_000;
// The tracker refuses an answer sent within a second or so of its picture, as no person types that fast.
const SETTLE_MS = 2_500;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class JetizzTracker {
  private readonly ocr = new JetizzOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver; settleMs?: number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
    if (!isJetizzNumber(number)) throw new InvalidInputError(PROVIDER, 'Jetizz numbers are ten or thirteen digits');
    return runSteps({ carrier: 'jetizz', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // BotDetect keeps the picture's code in the ASP.NET session the page opens. Without the
      // cookie that says cookies work, the page sends the request round a redirect to set it.
      const jar = new CookieJar();
      await jar.setCookie('AspxAutoDetectCookieSupport=1; Path=/', ORIGIN);
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, jar);
      const request = async (url: string, accept: string, maxBytes: number, body?: string) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
          headers: { Accept: accept, Referer: PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(body ? { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, redirect: 'manual', allowHttpStatuses: [301, 302, 404, 410] });
        if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Jetizz tracking is unavailable', { status: response.status });
        if (response.status !== 200) throw new ChallengeError(PROVIDER, 'Jetizz redirected the tracker instead of answering');
        return { response, bytes };
      };
      try {
        let refused = false;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const page = await request(`${PAGE}?AspxAutoDetectCookieSupport=1`, 'text/html,application/xhtml+xml', 200_000);
          const instance = botDetectInstance(decodeText(page.bytes), CAPTCHA);
          if (!instance) throw new SchemaError(PROVIDER, 'Jetizz returned its tracker without a captcha');
          const image = await request(`${PAGE}/BotDetectCaptcha.ashx?${new URLSearchParams({ get: 'image', c: CAPTCHA, t: instance.id })}`,
            'image/avif,image/webp,image/*,*/*;q=0.8', 20_000);
          const drawn = performance.now();
          const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image.bytes, signal);
          // A reading that is not four capitals or digits is not sent: a new picture is cheaper than a refused lookup.
          if (!ANSWER.test(code)) continue;
          // The form's script types the code with each character's case set by a counter it searches for.
          const answer = await botDetectAnswer(code, instance, signal);
          if (answer === null) throw new ChallengeError(PROVIDER, 'Jetizz captcha could not be answered');
          const wait = drawn + (this.options.settleMs ?? SETTLE_MS) - performance.now();
          if (wait > 0) {
            if (wait >= left()) break;
            if (!await paused(wait, signal)) signal.throwIfAborted();
          }
          const lookup = await request(`${PAGE}/Home/GonderiBilgi`, 'text/html, */*; q=0.01', 500_000,
            JSON.stringify({ searchModel: { TakipNo: number, CaptchaCode: answer, CaptchaId: CAPTCHA, CaptchaInstanceId: instance.id } }));
          try {
            return parseJetizz(decodeText(lookup.bytes), number);
          } catch (error) {
            if (!(error instanceof ChallengeError) || error.message !== 'Jetizz refused the captcha answer') throw error;
            refused = true;
          }
        }
        throw new ChallengeError(PROVIDER, refused ? 'Jetizz refused every captcha answer' : 'Jetizz captcha pictures could not be read');
      } catch (error) {
        // Raw transport diagnostics can carry the session cookie and the picture's answer.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JetizzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'jetizz', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
