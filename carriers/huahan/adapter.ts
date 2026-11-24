import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { DirectRest } from '../../core/runner/directRest.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlCapturedResponse, TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { huahanRefusal, normalizeHuahanNumber, parseHuahan, PROVIDER } from './parser.js';

const BASE = 'https://www.hh-exp.cn/WebTrack/';
export const HUAHAN_TRACKING = `${BASE}CargoTrackActionPlus.php`;
// The labels the browser service's helper gives a reply it could not read.
const VERIFICATION_PAGE = 'HuaHan verification returned a page';
const NOT_JSON = 'HuaHan tracking reply is not JSON';

/** Only the public widget's bounded, two-operand arithmetic grammar is accepted. */
export function solveHuahanQuestion(question: unknown): string {
  const match = typeof question === 'string' && /^\s*(\d{1,3})\s*([+\-×*x÷/])\s*(\d{1,3})\s*=\s*\?\s*$/.exec(question);
  if (!match) throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification question');
  const a = Number(match[1]), b = Number(match[3]);
  const answer = match[2] === '+' ? a + b : match[2] === '-' ? a - b : /[×*x]/.test(match[2]!) ? a * b : a / b;
  if (!Number.isSafeInteger(answer)) throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification answer');
  return String(answer);
}

function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(decodeText(bytes)); } catch { throw new SchemaError(PROVIDER, 'HuaHan returned unreadable tracking JSON'); }
}

/**
 * The browser service's run of the same form, which reads the picture's characters itself. Its
 * helper returns the tracking reply bound to the waybill, the widget's refusal in the reply's
 * shape, or nothing when no picture passed.
 */
export function parseHuahanCapture(captured: readonly TrawlCapturedResponse[], number: string): CarrierResult {
  const reply = captured.filter((row) => row.url === HUAHAN_TRACKING && row.trackingNumberSubmitted === number).at(-1);
  if (!reply) throw new ChallengeError(PROVIDER, 'HuaHan did not accept the picture verification', { reason: 'click_captcha' });
  if (reply.status === 429 || reply.status >= 500) throw new UpstreamHttpError(PROVIDER, reply.status);
  if (reply.status !== 200 || reply.error === VERIFICATION_PAGE) throw new ChallengeError(PROVIDER, 'HuaHan returned a verification page');
  if (reply.error === NOT_JSON || reply.truncated || reply.base64Encoded || reply.body === null && !reply.error) {
    throw new SchemaError(PROVIDER, 'HuaHan returned unreadable tracking JSON');
  }
  if (reply.error || reply.body === null) throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification mode');
  return parseHuahan(json(new TextEncoder().encode(reply.body)), number);
}

export class HuahanTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null;
    /** The proxy the browser service's helper sends HuaHan's requests through, for a service HuaHan does not answer. */
    browserProxy?: string | null; } = {}) {}

  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const timeoutMs = Math.floor(remainingMs);
    if (timeoutMs <= 2500) throw new BudgetExceededError(PROVIDER, timeoutMs);
    const page = await this.options.trawl!.scrape({
      url: `${BASE}CargoTrack.html?${new URLSearchParams({ ordernumber: number })}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs - 2000, captureResponses: [HUAHAN_TRACKING], ...(this.options.browserProxy ? { proxy: this.options.browserProxy } : {}),
    }, { provider: PROVIDER, signal, timeoutMs, maxBytes: 4_000_000, requireSolved: false, captureWindow: 'last', fetcher: this.options.fetcher });
    return parseHuahanCapture(page.capturedResponses, number);
  }

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeHuahanNumber(raw);
    // While HuaHan shows its picture, the browser service's step reads the parcel and the
    // direct step rests, as each of its tries opens a verification session HuaHan counts.
    const rest = new DirectRest('huahan', this.options.trawl);
    return runSteps({ carrier: 'huahan', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 20_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', enabled: !rest.resting, run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (path: string, maxBytes: number, body?: URLSearchParams) => {
        signal.throwIfAborted();
        const timeoutMs = Math.floor(deadline - performance.now());
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const { response, bytes } = await fetchBounded(BASE + path, {
          method: body ? 'POST' : 'GET', signal,
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
            Referer: BASE + 'CargoTrack.html', 'X-Requested-With': 'XMLHttpRequest',
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          ...(body ? { body: body.toString() } : {}),
        }, { provider: PROVIDER, timeoutMs, maxBytes, fetcher, allowHttpStatuses: [401, 403, 404, 410] });
        if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'HuaHan tracking is unavailable');
        if (response.status === 401 || response.status === 403 || /^\s*</.test(decodeText(bytes))) {
          throw new ChallengeError(PROVIDER, 'HuaHan returned a verification page');
        }
        return bytes;
      };
      try {
        const init = json(await request('init.php?_=' + Date.now(), 4096));
        if (isRecord(init) && init.ask === 0) huahanRefusal(init);
        if (!isRecord(init) || init.ask !== 1 || typeof init.token !== 'string' || !/^[a-zA-Z0-9_-]{8,256}$/.test(init.token)) {
          throw new ChallengeError(PROVIDER, 'HuaHan did not open verification');
        }
        // The form's own challenge: a picture whose characters are clicked in order, or, when
        // HuaHan switches to it, a plain arithmetic question.
        const params = new URLSearchParams({ token: init.token, _: String(Date.now()) });
        const challenge = json(await request('tncode.php?' + params.toString(), 400_000));
        if (isRecord(challenge) && challenge.ask === 0) huahanRefusal(challenge);
        if (isRecord(challenge) && challenge.ask === 1 && challenge.type !== 'text' && typeof challenge.img === 'string') {
          throw new ChallengeError(PROVIDER, 'HuaHan asked for its picture verification', { reason: 'click_captcha' });
        }
        if (!isRecord(challenge) || challenge.ask !== 1 || challenge.type !== 'text') {
          throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification mode');
        }
        const answer = solveHuahanQuestion(challenge.question);
        const verified = decodeText(await request('check.php?' + new URLSearchParams({ token: init.token, answer }).toString(), 4096));
        if (verified.trim() !== 'ok') throw new ChallengeError(PROVIDER, 'HuaHan refused arithmetic verification');
        return parseHuahan(json(await request('CargoTrackActionPlus.php', 1_000_000, new URLSearchParams({ ordernumber: number }))), number);
      } catch (error) {
        if (error instanceof ChallengeError && error.reason === 'click_captcha') rest.refused();
        // Verification URLs and session cookies must not enter transport diagnostics.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }, { id: 'trawl', enabled: Boolean(this.options.trawl), recovers: (error) => carrierErrorKind(error) === 'challenge',
      run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const browserProxy = environment.env.HUAHAN_BROWSER_PROXY_URL?.trim() || null;
  // Checked here, so a mistyped proxy fails at setup with a message that leaves its value out.
  if (browserProxy) browserContextProxy(browserProxy);
  const tracker = new HuahanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent,
    trawl: environment.trawl, browserProxy });
  return { id: 'huahan', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
