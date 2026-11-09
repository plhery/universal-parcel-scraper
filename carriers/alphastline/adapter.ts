import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ALPHASTLINE_MAX_BYTES, normalizeAlphastlineNumber, parseAlphastline, PROVIDER } from './parser.js';

/** The endpoint the tracking form on Alphastline's home page posts to. */
export const ALPHASTLINE_API = 'https://alphastline-api-gw.dsers.com/dsers-logistics-bff/v1/tracking/query';
const ALPHASTLINE_PAGE = 'https://www.alphastline.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Alphastline answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Alphastline returned a reply that is not JSON', { cause });
  }
}

export class AlphastlineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAlphastlineNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request, in English.
      const body = JSON.stringify({ language: 'en', erpOrderCode: [number] });
      const { response, bytes } = await fetchBounded(ALPHASTLINE_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: ALPHASTLINE_PAGE.slice(0, -1),
        Referer: ALPHASTLINE_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ALPHASTLINE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const text = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Alphastline redirected its tracking lookup', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Alphastline refused the lookup', { status: 403 });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Alphastline tracking lookup is unavailable', { status: response.status });
      return parseAlphastline(json(text), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'alphastline', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AlphastlineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'alphastline', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAlphastlineNumber(number))),
  };
};
