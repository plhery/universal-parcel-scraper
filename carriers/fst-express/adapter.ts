import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FST_MAX_BYTES, normalizeFstNumber, parseFst, PROVIDER } from './parser.js';

export { normalizeFstNumber, parseFst } from './parser.js';

/** The lookup the tracker page at www.fstexpress.com.au/track_and_trace/ makes, on FST's TMS. */
export const FST_LOOKUP = 'https://login.fstexpress.com.au/tms-saas-oms/expose/traceQueryResult';
/** The page's query type for a number of any kind: a job number or a reference. */
const QUERY_TYPE = '99';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks and firewall pages a proxy in front of the service could put in place of the reply.
const CHALLENGE = /sdwaf|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const DEFAULT_BUDGET_MS = 15_000;

export class FstExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page posts the number as a form, as jQuery does.
    const { response, bytes } = await fetchBounded(FST_LOOKUP, { method: 'POST', signal,
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent) },
      body: new URLSearchParams({ jobNo: number, queryType: QUERY_TYPE }).toString(),
    }, { provider: PROVIDER, timeoutMs, maxBytes: FST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // A redirect or a missing address is a moved service, not a missing parcel: the tracker answers every number with HTTP 200.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'FST Express tracking moved', { status: response.status });
    const body = decodeText(bytes);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FST Express answered with a browser check');
      throw new SchemaError(PROVIDER, 'FST Express returned a reply that is not JSON', { cause: error });
    }
    return parseFst(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFstNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FstExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
