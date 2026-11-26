import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ProfessionalCouriersOcr } from './ocr.js';
import {
  normalizeProfessionalCouriersNumber, parseProfessionalCouriers, professionalCouriersCaptchaFields, professionalCouriersDetailsFields,
  professionalCouriersPicture, professionalCouriersRefusedCaptcha, professionalCouriersRefusedNumber, professionalCouriersSearchFields,
  professionalCouriersVerifyFields, PROVIDER, TPC_GATE, TPC_HOME, TPC_ORIGIN, TPC_TRACK,
} from './parser.js';

export { parseProfessionalCouriers } from './parser.js';
const ANSWER = /^[A-Z0-9]{5}$/;
// Pictures per lookup. The shared model reads most of them; a wrong answer costs the picture.
const PICTURES = 3;
// Time one more picture needs: the picture, reading it and the answer.
const PICTURE_MS = 4_000;
const REDIRECTS = [301, 302, 303, 307, 308];
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class ProfessionalCouriersTracker {
  private readonly ocr = new ProfessionalCouriersOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeProfessionalCouriersNumber(raw);
    return runSteps({ carrier: 'professional-couriers', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      // The consignment, the captcha's code and the details all live in the ASP.NET session.
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (url: string, referer: string, options: { body?: URLSearchParams; picture?: boolean } = {}) => {
        const { response, bytes } = await fetchBounded(url, { signal, ...(options.body ? { method: 'POST', body: options.body.toString() } : {}),
          headers: { Accept: options.picture ? 'image/avif,image/webp,image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml',
            Referer: referer, 'User-Agent': userAgentOf(this.options.userAgent),
            ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: options.picture ? 20_000 : 1_000_000, fetcher, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'TPC refused its guest request');
        if (REDIRECTS.includes(response.status)) {
          const target = new URL(response.headers.get('location') ?? '', url);
          // Anything else, such as /Oops.aspx, is the tracker's error page.
          if (target.origin !== TPC_ORIGIN || ![TPC_GATE, TPC_TRACK].includes(`${target.origin}${target.pathname}`) || target.search) {
            throw new TransportError(PROVIDER, 'TPC answered with its error page', { status: response.status });
          }
          return { location: `${target.origin}${target.pathname}`, bytes };
        }
        if (response.status !== 200) throw new TransportError(PROVIDER, 'TPC tracking page moved', { status: response.status });
        return { location: undefined, bytes };
      };
      const page = async (url: string, referer: string, body?: URLSearchParams) => {
        const answer = await request(url, referer, { body });
        return { location: answer.location, html: answer.location ? '' : decodeText(answer.bytes) };
      };
      const follow = async (answer: { location?: string; html: string }, referer: string, expected: string) => {
        if (answer.location !== expected) throw new SchemaError(PROVIDER, 'TPC answered the search out of order');
        const next = await page(expected, referer);
        if (next.location) throw new SchemaError(PROVIDER, 'TPC answered the search out of order');
        return next.html;
      };
      try {
        const home = await page(TPC_HOME, TPC_HOME);
        if (home.location) throw new TransportError(PROVIDER, 'TPC tracking page moved');
        const searched = await page(TPC_HOME, TPC_HOME, professionalCouriersSearchFields(home.html, number));
        if (!searched.location) {
          if (professionalCouriersRefusedNumber(searched.html)) throw new NotFoundError(PROVIDER, 'TPC does not take the consignment number');
          throw new SchemaError(PROVIDER, 'TPC did not answer its consignment search');
        }
        let summary: string | undefined;
        if (searched.location === TPC_TRACK) summary = await follow(searched, TPC_HOME, TPC_TRACK);
        else {
          let gate = await follow(searched, TPC_HOME, TPC_GATE), refused = false, picture = professionalCouriersPicture(gate);
          for (let attempt = 0; attempt < PICTURES && !summary; attempt++) {
            if (attempt && left() < PICTURE_MS) break;
            const image = (await request(picture, TPC_GATE, { picture: true })).bytes;
            const code = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
            // A reading that is not five capitals or digits is not sent: the picture's refresh draws a new code.
            if (!ANSWER.test(code)) { picture = `${TPC_ORIGIN}/CaptchaImage.ashx?r=${Date.now()}`; continue; }
            const verified = await page(TPC_GATE, TPC_GATE, professionalCouriersCaptchaFields(gate, code));
            if (verified.location) { summary = await follow(verified, TPC_GATE, TPC_TRACK); break; }
            if (!professionalCouriersRefusedCaptcha(verified.html)) throw new SchemaError(PROVIDER, 'TPC did not answer its captcha');
            refused = true; gate = verified.html; picture = professionalCouriersPicture(gate);
          }
          if (!summary) throw new ChallengeError(PROVIDER, refused ? 'TPC refused every captcha answer' : 'TPC captcha pictures could not be read');
        }
        const details = await page(TPC_TRACK, TPC_TRACK, professionalCouriersDetailsFields(summary, number));
        if (details.location) throw new SchemaError(PROVIDER, 'TPC answered its details out of order');
        const verify = professionalCouriersVerifyFields(details.html);
        if (!verify) return parseProfessionalCouriers(details.html, number);
        const full = await page(TPC_TRACK, TPC_TRACK, verify);
        if (full.location) throw new SchemaError(PROVIDER, 'TPC answered its details out of order');
        return parseProfessionalCouriers(full.html, number);
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
  const tracker = new ProfessionalCouriersTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'professional-couriers', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
