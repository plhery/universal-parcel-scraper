import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeUralNumber, parseUral, PROVIDER, URAL_LOOKUP, URAL_MAX_BYTES } from './parser.js';

export { normalizeUralNumber, parseUral, URAL_LOOKUP } from './parser.js';

const TRACKER_PAGE = 'https://tmsplus.ilinexpress.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Ural Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Ural Express returned a reply that is not JSON', { cause });
  }
}

export class UralExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the tracking page makes, with the number as the only one asked. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(URAL_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: TRACKER_PAGE.slice(0, -1), Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify([number]) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: URAL_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const text = decodeText(bytes);
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Ural Express redirected its tracking lookup', { status: response.status });
    if (response.status === 403) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Ural Express answered with a browser check', { status: 403 });
      throw new ChallengeError(PROVIDER, 'Ural Express refused the lookup', { status: 403, reason: 'api_denied' });
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Ural Express tracking lookup is unavailable', { status: response.status });
    return parseUral(json(text), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUralNumber(raw);
    // A read that fails to reach the service, or hangs, gets one more try: the first gets half of
    // the budget, so the retry fits in the rest. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Ural Express for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new UralExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
