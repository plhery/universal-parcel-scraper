import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { isRecord } from '../../core/types.js';
import { WahanaOcr } from './ocr.js';
import { normalizeWahanaNumber, parseWahana, PROVIDER, WAHANA_MAX_BYTES } from './parser.js';

const HOME = 'https://www.wahana.com/';
const CAPTCHA = 'https://wcaptcha.wahana.com/api.php';

export function wahanaQuestionTarget(question: unknown): string | null {
  return typeof question === 'string' ? /^(?:Klik huruf\/angka |Please click on the |Click the |Find the )([A-Za-z0-9])\.$/.exec(question)?.[1]?.toUpperCase() ?? null : null;
}

export class WahanaTracker {
  private readonly ocr = new WahanaOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder;
    solveCaptcha?: (bytes: Uint8Array, signal: AbortSignal) => Promise<string> } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeWahanaNumber(raw);
    return runSteps({ carrier: 'wahana', signal: context.signal, budgetMs: context.budgetMs ?? 25_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (url: string | URL, maxBytes: number) => {
        const { response, bytes } = await fetchBounded(url, { signal, headers: {
          'User-Agent': userAgentOf(this.options.userAgent), Referer: HOME, Origin: new URL(HOME).origin,
        } }, { provider: PROVIDER, fetcher, timeoutMs: Math.min(8_000, left()), maxBytes, allowHttpStatuses: [400, 403, 404, 422] });
        left();
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'Wahana refused its guest request');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Wahana guest tracking is unavailable', { status: response.status });
        return bytes;
      };
      try {
        await request(HOME, WAHANA_MAX_BYTES);
        for (let attempt = 0; attempt < 2; attempt++) {
          let challenge: unknown;
          try { challenge = JSON.parse(decodeText(await request(CAPTCHA + '?action=new', 16_384))); }
          catch (error) { if (error instanceof SyntaxError) throw new SchemaError(PROVIDER, 'Wahana returned unreadable verification JSON'); throw error; }
          const target = isRecord(challenge) ? wahanaQuestionTarget(challenge.question_i) : null;
          if (!isRecord(challenge) || !target || typeof challenge.session !== 'string' || !/^[A-Za-z0-9.]{32,120}$/.test(challenge.session)
            || !Array.isArray(challenge.answers) || challenge.answers.length !== 5
            || !challenge.answers.every(answer => typeof answer === 'string' && /^[a-f0-9]{20}$/.test(answer))
            || new Set(challenge.answers).size !== 5) throw new ChallengeError(PROVIDER, 'Wahana changed its image verification');
          const choices: string[] = [];
          for (let index = 0; index < challenge.answers.length; index++) {
            const url = new URL(CAPTCHA);
            url.search = new URLSearchParams({ action: 'img', s: challenge.session, c: challenge.answers[index] as string }).toString();
            const bytes = await request(url, 100_000);
            const answer = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(bytes, signal);
            left();
            if (/^[A-Za-z0-9]$/.test(answer) && answer.toUpperCase() === target) choices.push(challenge.answers[index] as string);
          }
          if (choices.length !== 1) {
            if (!attempt) continue;
            throw new ChallengeError(PROVIDER, 'Wahana image verification could not be read uniquely');
          }
          const url = new URL('lacak-kiriman', HOME);
          url.search = new URLSearchParams({ noresi: number, captcheck_selected_answer: choices[0]!,
            captcheck_session_code: challenge.session, captcheck_aa: typeof challenge.aa === 'string' ? challenge.aa : 'undefined' }).toString();
          const html = decodeText(await request(url, WAHANA_MAX_BYTES));
          try { return parseWahana(html, number); }
          catch (error) { if (!attempt && error instanceof ChallengeError && error.reason === 'verification_rejected') continue; throw error; }
        }
        throw new ChallengeError(PROVIDER, 'Wahana refused image verification');
      } catch (error) {
        // URLs and request diagnostics carry per-generation verification state.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WahanaTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'wahana', steps: ['direct'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
