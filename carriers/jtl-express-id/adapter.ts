import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAX_BYTES, normalizeJtlExpressNumber, parseJtlExpress, PROVIDER } from './parser.js';

export { jtlExpressDescription, normalizeJtlExpressNumber, parseJtlExpress } from './parser.js';

const ORIGIN = 'https://www.jtlexpress.co.id';
/** The tracking page, which the lookup names as its referrer. */
export const JTL_EXPRESS_PAGE = `${ORIGIN}/Tracking`;
/** The lookup the page's script makes for a resi once its picture code matches. */
export const jtlExpressLookupUrl = (number: string): string => `${ORIGIN}/Tracking/Resitracking?${new URLSearchParams({ resi: number })}`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown resi with HTTP 200; a 404 or 410 is a moved route.
const GONE = [404, 410];
// Bot checks a firewall could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|awswaf|<title>\s*(?:Just a moment|Access Denied|Attention Required|Request Rejected)/i;

export class JtlExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeJtlExpressNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // The form's picture code is compared in the page with the answer the page itself carries; the
    // lookup the page then makes needs neither the code nor a session.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const lookup = await fetchBounded(jtlExpressLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': userAgent, Referer: JTL_EXPRESS_PAGE,
        'X-Requested-With': 'XMLHttpRequest' } }, { provider: PROVIDER, timeoutMs, maxBytes: MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      const { status } = lookup.response;
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'JTL Express\'s tracking lookup is unavailable', { status });
      const text = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JTL Express answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'JTL Express returned a reply that is not JSON', { cause });
      }
      return parseJtlExpress(data, number);
    };
    // An attempt that fails to reach JTL Express, or hangs, gets one more: the first gets half of
    // the budget, so the retry fits in the rest.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JtlExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
