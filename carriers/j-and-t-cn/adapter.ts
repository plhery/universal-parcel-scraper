import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext, TrackingInput } from '../../core/adapter/index.js';
import { ChallengeError, InputRequiredError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  J_AND_T_CN_MAX_BYTES, jAndTCnAnswer, jAndTCnHasScans, normalizeJAndTCnNumber, parseJAndTCn, PROVIDER,
} from './parser.js';

/** The lookup the tracking page on www.jtexpress.com.cn makes for waybills and the phone digits a visitor types. */
export const J_AND_T_CN_API = 'https://official.jtexpress.com.cn/official/waybill/trackingCustomerByWaybillNo/v_7';
/** The page's second stage, for the scans of an answer that lists none, with the code that answer gave. */
export const J_AND_T_CN_SCANS_API = 'https://official.jtexpress.com.cn/official/waybill/trackingCustomerByWaybillNo/v_5';
/** The constant the page signs every request's time with, the same for every visitor. */
export const J_AND_T_CN_SIGNING_SALT = 'ajsa28jh12j2adSwaybF&Ui'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|AwsWafIntegration|awswaf\.com/i;

/**
 * The phone digits the lookup takes: the last four of the recipient's or
 * sender's phone or landline, as the page's dialog asks. Without them the
 * tracker shows nothing, so no request is made.
 */
export function jAndTCnPhoneDigits(input: Pick<TrackingInput, 'phoneDigits'>): string {
  const digits = typeof input.phoneDigits === 'string' ? input.phoneDigits.trim() : '';
  if (!/^\d{4}$/.test(digits)) {
    throw new InputRequiredError(PROVIDER, 'phoneDigits',
      'J&T Express China shows a parcel only with the last four digits of the recipient’s or sender’s phone');
  }
  return digits;
}

/** The page's headers for a request at `times`: the time and its signature, MD5 of MD5 of the salt and the time. */
export function jAndTCnSignedHeaders(times = Date.now()): { times: string; sign: string } {
  const md5 = (text: string) => createHash('md5').update(text).digest('hex');
  return { times: String(times), sign: md5(md5(`${J_AND_T_CN_SIGNING_SALT}${times}`)) };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    // A JSON lookup answering with a page has been turned away.
    if (CHALLENGE.test(body.slice(0, 64_000)) || /^\s*</.test(body)) {
      throw new ChallengeError(PROVIDER, 'J&T Express China answered with a page instead of its lookup', { cause });
    }
    throw new SchemaError(PROVIDER, 'J&T Express China returned a reply that is not JSON', { cause });
  }
}

export class JAndTCnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': userAgentOf(this.options.userAgent),
      ...jAndTCnSignedHeaders(),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: J_AND_T_CN_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'J&T Express China redirected its tracking lookup');
    // The lookup answers every waybill with HTTP 200; a 404 is a moved route, not an unknown parcel.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'J&T Express China tracking lookup is unavailable');
    return json(decodeText(bytes));
  }

  async fetch(input: TrackingInput, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJAndTCnNumber(input.number);
    const digits = jAndTCnPhoneDigits(input);
    // The page's query: the captcha's random string and ticket stay empty, as the page sends them.
    const url = `${J_AND_T_CN_API}?${new URLSearchParams({ waybillList: number, randstr: '', ticket: '', phoneLast: digits })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const started = Date.now();
      const answer = jAndTCnAnswer(await this.get(url, signal, timeoutMs), number);
      if (jAndTCnHasScans(answer) || typeof answer.code !== 'string' || !answer.code) return parseJAndTCn(answer, number);
      // An answer without scans: the page asks the second stage with the code the answer gave, then lists those.
      const scans = `${J_AND_T_CN_SCANS_API}?${new URLSearchParams({ waybillList: answer.keyword as string, code: answer.code })}`;
      const second = jAndTCnAnswer(await this.get(scans, signal, timeoutMs - (Date.now() - started)), number);
      return parseJAndTCn({ ...answer, details: second.details }, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'j-and-t-cn', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JAndTCnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'j-and-t-cn', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input, context),
  };
};
