import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { VnpostOcr } from './ocr.js';
import { isVnpostNumber, parseVnpost, PROVIDER } from './parser.js';

export { parseVnpost } from './parser.js';
const ORIGIN = 'https://vnpost.vn';
const PAGE = `${ORIGIN}/vi/ca-nhan/chuyen-phat/chuyen-phat-trong-nuoc`;
const PICTURE = /^https:\/\/vnpost\.vn\/captcha\/default\?[A-Za-z0-9]{1,40}$/;
const ANSWER = /^[A-Za-z0-9]{4}$/;
// Pictures per lookup. The model reads nearly every picture right; the tracker refuses a wrong
// answer before it looks the number up, and a new picture costs two short requests.
const PICTURES = 5;
// Time one more picture needs: its address, the picture, reading it and the lookup.
const PICTURE_MS = 4_000;
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class VnpostTracker {
  private readonly ocr = new VnpostOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
    if (!isVnpostNumber(number)) throw new InvalidInputError(PROVIDER, 'VNPost item numbers are letters and digits');
    return runSteps({ carrier: 'vnpost', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // The tracker keeps the picture's answer in the Laravel session its first request opens.
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (url: string, accept: string, maxBytes: number, xhr = true) => {
        const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: accept, Referer: PAGE,
          'User-Agent': userAgentOf(this.options.userAgent), ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, allowHttpStatuses: [404, 410, 422] });
        if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'VNPost tracking is unavailable', { status: response.status });
        return { status: response.status, bytes };
      };
      const json = (bytes: Uint8Array) => {
        if (/^\s*</.test(decodeText(bytes.subarray(0, 256)))) throw new ChallengeError(PROVIDER, 'VNPost answered with a web page instead of its tracking reply');
        return parseJsonBytes(bytes, PROVIDER);
      };
      try {
        let refused = false;
        for (let picture = 0; picture < PICTURES; picture++) {
          if (picture && left() < PICTURE_MS) break;
          const fresh = await request(`${ORIGIN}/handle-captcha/refresh-captcha`, 'application/json, text/plain, */*', 4_096);
          const reply = fresh.status === 200 ? json(fresh.bytes) : null;
          const address = isRecord(reply) && typeof reply.captcha === 'string' ? reply.captcha : '';
          if (!PICTURE.test(address)) throw new SchemaError(PROVIDER, 'VNPost returned no captcha picture');
          const image = await request(address, 'image/avif,image/webp,image/*,*/*;q=0.8', 20_000, false);
          if (image.status !== 200) throw new SchemaError(PROVIDER, 'VNPost returned no captcha picture');
          const answer = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image.bytes, signal);
          // A reading that is not four letters or digits is not sent: the next picture is cheaper than a refused lookup.
          if (!ANSWER.test(answer)) continue;
          const lookup = await request(`${ORIGIN}/postcode/thong-tin?${new URLSearchParams({ post_code: number, captcha: answer })}`,
            'application/json, text/plain, */*', 1_000_000);
          try {
            return parseVnpost(json(lookup.bytes), number);
          } catch (error) {
            if (!(error instanceof ChallengeError) || error.message !== 'VNPost refused the captcha answer') throw error;
            refused = true;
          }
        }
        throw new ChallengeError(PROVIDER, refused ? 'VNPost refused every captcha answer' : 'VNPost captcha pictures could not be read');
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
  const tracker = new VnpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'vnpost', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
