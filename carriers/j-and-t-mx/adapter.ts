import { readerLanguage, type AdapterFactory, type TrackingContext, type TrackingInput } from '../../core/adapter/index.js';
import { ChallengeError, InputRequiredError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { J_AND_T_MX_MAX_BYTES, J_AND_T_MX_REQUEST_ZONE, normalizeJAndTMxNumber, parseJAndTMx, PROVIDER } from './parser.js';

/** The lookup the tracking page on www.jtexpress.mx makes for a waybill and the phone digits a visitor types. */
export const J_AND_T_MX_API = 'https://official.jtjms-mx.com/official/logisticsTracking/v3/getDetailByWaybillNo';
// The page's languages, by the reader's; Spanish otherwise.
const LANGUAGES = { es: 'ES', en: 'EN', zh: 'CN' } as const;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|AwsWafIntegration|awswaf\.com/i;

/**
 * The phone digits the lookup takes: the last four of the recipient's or
 * sender's phone, as the page's four boxes ask. Without them the tracker
 * shows nothing, so no request is made.
 */
export function jAndTMxPhoneDigits(input: Pick<TrackingInput, 'phoneDigits'>): string {
  const digits = typeof input.phoneDigits === 'string' ? input.phoneDigits.trim() : '';
  if (!/^\d{4}$/.test(digits)) {
    throw new InputRequiredError(PROVIDER, 'phoneDigits',
      'J&T Express Mexico shows a parcel only with the last four digits of the recipient’s or sender’s phone');
  }
  return digits;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    // A JSON lookup answering with a page has been turned away.
    if (CHALLENGE.test(body.slice(0, 64_000)) || /^\s*</.test(body)) {
      throw new ChallengeError(PROVIDER, 'J&T Express Mexico answered with a page instead of its lookup', { cause });
    }
    throw new SchemaError(PROVIDER, 'J&T Express Mexico returned a reply that is not JSON', { cause });
  }
}

export class JAndTMxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(input: TrackingInput, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJAndTMxNumber(input.number);
    const digits = jAndTMxPhoneDigits(input);
    const language = LANGUAGES[readerLanguage(input, ['es', 'en', 'zh']) ?? 'es'];
    const url = `${J_AND_T_MX_API}?${new URLSearchParams({ waybillNo: number, langType: language, phoneVerify: digits })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
        // The page's headers: its language, its visitor's zone, which the scan times come in, and an empty session token.
        langType: language, timezone: J_AND_T_MX_REQUEST_ZONE, token: '',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: J_AND_T_MX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'J&T Express Mexico redirected its tracking lookup');
      // The lookup answers every waybill with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'J&T Express Mexico tracking lookup is unavailable');
      return parseJAndTMx(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'j-and-t-mx', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JAndTMxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'j-and-t-mx', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input, context),
  };
};
