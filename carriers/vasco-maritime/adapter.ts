import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseVascoBill, parseVascoMoves, PROVIDER, VASCO_MAX_BYTES, vascoQuery, vascoResult } from './parser.js';

/** The tracking page, whose searches the adapter makes. */
export const VASCO_PAGE = 'https://www.vascomaritime.com/track';
/** The Goodrich Group's booking system, which the page asks for a bill, a container and a bill's moves. */
export const VASCO_TRACKER = 'https://grglobal.goodrichapps.com/ebms/TESTJson.asp';
// A bot check a CDN could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|<title>\s*Attention Required/i;

export class VascoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = vascoQuery(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const request = async (fields: Record<string, string>, what: string): Promise<string> => {
        signal.throwIfAborted();
        // The page sends an empty key: a guest has no session.
        const body = new URLSearchParams({ ...fields, keyCode: '', Id1: '' }).toString();
        const { response, bytes } = await fetchBounded(VASCO_TRACKER, { method: 'POST', signal, headers: {
          Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgent,
          Origin: 'https://www.vascomaritime.com', Referer: VASCO_PAGE,
        }, body }, { provider: PROVIDER, timeoutMs: left(), maxBytes: VASCO_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [403, 404, 429], fetcher: this.options.fetcher });
        const text = decodeText(bytes);
        if (response.status === 429) throw new RateLimitedError(PROVIDER);
        if (response.status === 403 || CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `Vasco Maritime refused its ${what}`, { status: response.status });
        if (response.status !== 200) throw new TransportError(PROVIDER, `Vasco Maritime's ${what} is unavailable`, { status: response.status });
        return text;
      };

      const bill = parseVascoBill(query.kind === 'bill'
        ? await request({ ProType: 'GETBLDTLS', BlNo: query.number }, 'bill')
        : await request({ ProType: 'GETCONTAINERDTLS', ContainerNo: query.number }, 'container'), query);
      const moves = await request({ ProType: 'GETBLCONTAINERDTLS', BlNo: bill.bill, VoyageId: bill.voyage }, 'container moves');
      return vascoResult(parseVascoMoves(moves, bill, query));
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more: the first gets half
    // of the budget, so the retry fits in the rest. The tracker takes about twenty seconds to find
    // a container, so a container's first attempt gets the whole budget.
    return runSteps({ carrier: 'vasco-maritime', budgetMs: context.budgetMs ?? 40_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, query.kind === 'container' ? remainingMs : firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VascoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vasco-maritime', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
