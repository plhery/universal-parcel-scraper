import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GAINT_MAX_BYTES, gaintRefusal, normalizeGaintNumber, parseGaint, PROVIDER, readGaintCode } from './parser.js';

/** The security code the tracking form shows, and the lookup it sends with it. */
export const GAINT_CAPTCHA_API = 'https://gaintlogistic.com/api/captcha';
export const GAINT_TRACK_API = 'https://gaintlogistic.com/api/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;
// A code that does not match gets one more, as the form shows a new one.
const CODE_ATTEMPTS = 2;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Gaint answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Gaint returned a reply that is not JSON', { cause });
  }
}

/** A refusal every request of the tracker can meet: a rate limit, a firewall, a moved route. */
function refused(status: number): void {
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if (status === 403) throw new ChallengeError(PROVIDER, 'Gaint refused the tracking lookup');
  if (REDIRECTS.includes(status)) throw new TransportError(PROVIDER, 'Gaint redirected its tracking lookup');
  if (status === 410) throw new TransportError(PROVIDER, 'Gaint tracking lookup is unavailable');
}

export class GaintTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGaintNumber(raw);
    const request = async (url: string, init: RequestInit, signal: AbortSignal, deadline: number) => {
      const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: GAINT_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 429] });
      refused(response.status);
      return { status: response.status, payload: json(decodeText(bytes)) };
    };
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 1; ; attempt += 1) {
        // Each lookup takes a fresh code, which the server binds to its token.
        const challenge = await request(GAINT_CAPTCHA_API, { method: 'GET' }, signal, deadline);
        if (challenge.status !== 200) throw new TransportError(PROVIDER, 'Gaint security code is unavailable');
        const code = readGaintCode(challenge.payload);
        const { status, payload } = await request(GAINT_TRACK_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ awb: number, captchaToken: code.token, captchaAnswer: code.answer }) }, signal, deadline);
        if (status === 200) return parseGaint(payload, number);
        try {
          gaintRefusal(payload, status);
        } catch (error) {
          if (!(error instanceof ChallengeError) || attempt >= CODE_ATTEMPTS) throw error;
        }
      }
    };
    // A read that fails to reach Gaint, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gaint-logistic', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GaintTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gaint-logistic', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
