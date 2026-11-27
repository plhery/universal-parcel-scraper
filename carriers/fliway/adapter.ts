import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { ISRG_ROOT_YR_X1 } from './certificate.js';
import {
  FLIWAY_MAX_BYTES, fliwayMissing, fliwayPayload, normalizeFliwayNumber, parseFliwayConsignment, parseFliwayItem, PROVIDER,
} from './parser.js';

export { normalizeFliwayNumber, parseFliwayConsignment, parseFliwayItem } from './parser.js';

/** The lookup the tracker page at online.fliway.com/Public/Track/ posts its number to. */
export const FLIWAY_LOOKUP = 'https://online.fliway.com/Fme/Public';
const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;
// The site sends its certificate without the cross-signed root between its intermediate and one Node trusts.
let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([ISRG_ROOT_YR_X1]);

/** The bodies the tracker page's script posts: a consignment note number, or an item's number. */
export const fliwayRequest = (number: string, lookup: 'connote' | 'item'): string => JSON.stringify(lookup === 'connote'
  ? { requestType: 'PTRK', connoteNumber: number } : { requestType: 'PTRK', trackNum: number });

export class FliwayTracker {
  readonly #fetcher: typeof fetch;

  /** Over the global fetch, the lookup is read trusting the certificate its chain leaves out; a host's own fetcher is used as given. */
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    this.#fetcher = transportOf(options.fetcher) === undefined ? trustingFetch() : options.fetcher!;
  }

  private async ask(number: string, lookup: 'connote' | 'item', signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(FLIWAY_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: fliwayRequest(number, lookup) }, { provider: PROVIDER, timeoutMs, maxBytes: FLIWAY_MAX_BYTES, redirect: 'manual',
      fetcher: this.#fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 401, 403] });
    // RedShield's firewall answers 403 with its block page to the addresses it refuses.
    if (response.status === 401 || response.status === 403) {
      throw new ChallengeError(PROVIDER, "Fliway's firewall refused the lookup", { status: response.status });
    }
    // Both lookups answer an unknown number with HTTP 200; a redirect or a missing route is a moved lookup.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Fliway tracking lookup moved', { status: response.status });
    return fliwayPayload(decodeText(bytes), response.headers.get('content-type') ?? '');
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    // The tracker opens a consignment by its note number and an item by its own; an item's number is
    // unknown to the consignment lookup, so a number that lookup does not know is asked of the item lookup.
    const consignment = await this.ask(number, 'connote', signal, left());
    if (!fliwayMissing(consignment, number, 'connote')) return parseFliwayConsignment(consignment, number);
    signal.throwIfAborted();
    const item = await this.ask(number, 'item', signal, left());
    if (fliwayMissing(item, number, 'item')) throw new NotFoundError(PROVIDER, 'Fliway has no consignment or item under this number');
    return parseFliwayItem(item, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeFliwayNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FliwayTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
