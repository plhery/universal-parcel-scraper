import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { MAILAMERICAS_MAX_BYTES, normalizeMailamericasNumber, parseMailamericas, PROVIDER } from './parser.js';

/** The lookup the tracking page on mailamericas.com makes for the number typed in. */
export const MAILAMERICAS_API = 'https://mailamericas.com/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The bare page AWS's load balancer answers with when it refuses a request.
const BALANCER_REFUSAL = /<title>\s*403 Forbidden\s*<\/title>/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'MailAmericas answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'MailAmericas returned a reply that is not JSON', { cause });
  }
}

export class MailamericasTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const timeoutMs = Math.floor(remainingMs);
    if (timeoutMs <= 2500) throw new BudgetExceededError(PROVIDER, timeoutMs);
    const page = await this.options.trawl!.scrape({
      url: `https://mailamericas.com/tracking?number_id=${number}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs - 2000, captureResponses: [MAILAMERICAS_API],
    }, { provider: PROVIDER, signal, timeoutMs, maxBytes: 4 * MAILAMERICAS_MAX_BYTES,
      requireSolved: false, captureWindow: 'last', allowHttpStatuses: [403, 405], fetcher: this.options.fetcher });
    // A helper binds the POST, even when the carrier's unknown-item reply has no identity.
    const replies = page.capturedResponses.filter(entry => entry.url === MAILAMERICAS_API && entry.trackingNumberSubmitted === number);
    const reply = replies.at(-1);
    if (!reply) throw new ChallengeError(PROVIDER, 'MailAmericas browser verification did not yield a bound tracking reply', { reason: 'verification_unfinished' });
    if (reply.headers['x-amzn-waf-action'] || [202, 403, 405].includes(reply.status)) {
      throw new ChallengeError(PROVIDER, 'MailAmericas browser verification remained blocked', { status: reply.status, reason: 'verification_refused' });
    }
    if (reply.status === 429 || reply.status >= 500) {
      const retry = reply.headers['retry-after'];
      const retryAfterMs = retry === undefined ? undefined : /^\d+$/.test(retry.trim())
        ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw new UpstreamHttpError(PROVIDER, reply.status, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : undefined);
    }
    if (reply.status !== 200) throw new TransportError(PROVIDER, 'MailAmericas browser tracking did not answer', { status: reply.status });
    if (reply.truncated || reply.base64Encoded || reply.error || reply.body === null
      || new TextEncoder().encode(reply.body).length > MAILAMERICAS_MAX_BYTES) {
      throw new SchemaError(PROVIDER, 'MailAmericas browser tracking returned an unreadable reply');
    }
    return parseMailamericas(json(reply.body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMailamericasNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(MAILAMERICAS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        Origin: 'https://mailamericas.com', Referer: 'https://mailamericas.com/tracking',
      }, body: JSON.stringify({ trackingNumber: number, language: 'en' }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: MAILAMERICAS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'MailAmericas redirected its tracking lookup');
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'MailAmericas tracking lookup is unavailable');
      if (response.status === 403) {
        // The balancer refuses an address that asked too often for a few minutes,
        // and some clients' names outright, with the same page.
        if (BALANCER_REFUSAL.test(decodeText(bytes).slice(0, 4_000))) {
          throw new RateLimitedError(PROVIDER, undefined, 'MailAmericas refused the lookup at its load balancer', { status: 403 });
        }
        throw new ChallengeError(PROVIDER, 'MailAmericas refused the lookup', { status: 403 });
      }
      // AWS's firewall holds a request it wants a browser to verify with an empty 202 (`x-amzn-waf-action`).
      if (response.headers.has('x-amzn-waf-action') || (response.status === 202 && !bytes.byteLength)) {
        throw new ChallengeError(PROVIDER, 'MailAmericas held the lookup for a browser check', { status: response.status });
      }
      return parseMailamericas(json(decodeText(bytes)), number);
    };
    // One read with the whole budget: a parcel the service has not looked up
    // lately takes it twenty seconds to answer.
    return runSteps({ carrier: 'mailamericas', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 30_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
      { id: 'trawl', enabled: Boolean(this.options.trawl), recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MailamericasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new MailamericasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mailamericas', recordsSteps: true, steps: ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeMailamericasNumber(number))),
  };
};
