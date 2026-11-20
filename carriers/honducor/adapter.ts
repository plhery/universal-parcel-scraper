import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HONDUCOR_MAX_BYTES, HONDUCOR_ORIGIN, honducorForm, honducorResultUrl, normalizeHonducorNumber, parseHonducor, PROVIDER } from './parser.js';
import { parseHonducorChallenge, solveHonducorChallenge } from './pow.js';

export class HonducorTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeHonducorNumber(raw);
    return runSteps({ carrier: 'honducor', budgetMs: context.budgetMs ?? 40_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs, jar = new CookieJar();
      const session = makeFetchCookie(this.options.fetcher ?? fetch, jar);
      const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent), Referer: HONDUCOR_ORIGIN + '/' };
      const read = async (url: string, init: RequestInit, maxBytes = HONDUCOR_MAX_BYTES) => {
        signal.throwIfAborted();
        const left = Math.floor(deadline - performance.now());
        if (left <= 0) throw new BudgetExceededError(PROVIDER, remainingMs);
        try {
          return await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left,
            maxBytes, redirect: 'manual', fetcher: session,
            allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410] });
        } catch (error) {
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, new Error('Honducor tracking request failed'));
          throw error;
        }
      };
      const ok = (status: number) => { if (status !== 200) throw new TransportError(PROVIDER, 'Honducor tracking service is unavailable', { status }); };
      try {
        const page = await read(HONDUCOR_ORIGIN + '/', { method: 'GET', headers }); ok(page.response.status);
        const fields = honducorForm(decodeText(page.bytes));
        const issued = await read(HONDUCOR_ORIGIN + '/rastreo/altcha/challenge', { method: 'GET', headers: { ...headers, Accept: 'application/json' } }, 16_000);
        ok(issued.response.status);
        let challenge: unknown;
        const challengeBody = decodeText(issued.bytes);
        try { challenge = JSON.parse(challengeBody); }
        catch {
          if (/_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(challengeBody.slice(0, 64_000))) {
            throw new ChallengeError(PROVIDER, 'Honducor answered with a browser check');
          }
          throw new SchemaError(PROVIDER, 'Honducor returned a challenge that is not JSON');
        }
        const proof = await solveHonducorChallenge(parseHonducorChallenge(challenge), signal, deadline - 2500, remainingMs);
        signal.throwIfAborted();fields.set('tracking_number', number);fields.set('altcha', proof);
        const reply = await read(HONDUCOR_ORIGIN + '/rastreo', { method: 'POST', body: fields.toString(), headers: {
          ...headers, Origin: HONDUCOR_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (reply.response.status === 200) return parseHonducor(decodeText(reply.bytes), number);
        if (reply.response.status !== 303) throw new TransportError(PROVIDER, 'Honducor did not return its tracking result', { status: reply.response.status });
        const url = honducorResultUrl(reply.response.headers.get('Location'), number);
        const result = await read(url, { method: 'GET', headers });ok(result.response.status);
        return parseHonducor(decodeText(result.bytes), number);
      } finally { await jar.removeAllCookies(); }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HonducorTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'honducor', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
