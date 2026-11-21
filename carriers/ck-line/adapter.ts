import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CK_LINE_MAX_BYTES, ckLineQuery, ckLineResult, parseCkLineContainers, parseCkLineMoves, PROVIDER } from './parser.js';

const ORIGIN = 'https://es.ckline.co.kr';
/** The e-service's cargo tracking page, whose searches the adapter makes. */
export const CK_LINE_PAGE = `${ORIGIN}/?cmd=TRK`;
/** The containers of a bill or booking, and a container's moves under its bill. */
export const CK_LINE_CONTAINERS = `${ORIGIN}/action/sup.WESSUP411.WESSUP411R02`;
export const CK_LINE_MOVES = `${ORIGIN}/action/sup.WESSUP411.WESSUP411R03`;
// A bot check a CDN could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|<title>\s*Attention Required/i;
// A bill's containers whose moves are read; the others are left out and the history marked truncated.
const MOVE_PANELS = 12;

export class CkLineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = ckLineQuery(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const request = async (url: string, reqData: Record<string, string>, what: string): Promise<unknown> => {
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'Content-Type': 'application/json; charset="UTF-8"', 'User-Agent': userAgent, Referer: CK_LINE_PAGE,
        }, body: JSON.stringify({ reqMeta: {}, reqData }) }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CK_LINE_MAX_BYTES,
          redirect: 'manual', allowHttpStatuses: [403, 404, 429], fetcher: this.options.fetcher });
        const body = decodeText(bytes);
        if (response.status === 429) throw new RateLimitedError(PROVIDER);
        if (response.status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `CK Line refused its ${what}`, { status: response.status });
        if (response.status !== 200) throw new TransportError(PROVIDER, `CK Line's ${what} is unavailable`, { status: response.status });
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new SchemaError(PROVIDER, `CK Line returned an unreadable ${what}`);
        }
      };

      // The search takes a bill without its prefix; a container's moves are kept under the whole bill.
      const listed = await request(CK_LINE_CONTAINERS, { INBNO: query.search, INTYP: query.kind === 'bill' ? 'BNO' : 'BKN', LANG: '', CNO: '' }, 'container list');
      const containers = parseCkLineContainers(listed, query);
      const moves = await Promise.all(containers.slice(0, MOVE_PANELS).map(async container => parseCkLineMoves(
        await request(CK_LINE_MOVES, { INBNO: container.bill, INTYP: 'BNO', LANG: 'EN', CNO: container.number }, 'container moves'), container)));
      return ckLineResult(moves, containers.length > MOVE_PANELS);
    };
    // A failed container read ends the others still running, so none outlives its attempt.
    const ending = (signal: AbortSignal, timeoutMs: number) => {
      const sibling = new AbortController();
      return attempt(AbortSignal.any([signal, sibling.signal]), timeoutMs).finally(() => sibling.abort());
    };
    // An attempt that fails to reach the e-service, or hangs, gets one more: the first gets half
    // of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ck-line', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => ending(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => ending(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CkLineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ck-line', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
