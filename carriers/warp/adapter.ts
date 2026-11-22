import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeWarpNumber, parseWarp, PROVIDER, WARP_MAX_BYTES } from './parser.js';

export { normalizeWarpNumber, parseWarp } from './parser.js';

/** The reply tracking.wearewarp.com builds its page from, with the events' titles (`fe=true`). */
export const WARP_TRACKING = 'https://gw.wearewarp.com/api-tracking/';
/** The stops the page draws on its map, whose service names a code it does not know. */
export const WARP_STOPS = 'https://gw.wearewarp.com/api/v1/p/tracking/';
const DEFAULT_BUDGET_MS = 20_000;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|awswaf|captcha|<title>\s*(?:Just a moment|Access Denied|Attention Required|Request Rejected)/i;

const isJson = (response: Response) => /^application\/json\b/i.test(response.headers.get('content-type') ?? '');

function jsonOf(bytes: Uint8Array, response: Response, what: string): unknown {
  const body = decodeText(bytes);
  if (!isJson(response)) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'WARP answered with a browser check');
    throw new SchemaError(PROVIDER, `WARP answered ${what} with a page instead of JSON`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new SchemaError(PROVIDER, `WARP returned ${what} that is not JSON`, { cause: error });
  }
}

export class WarpTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private get(url: string, signal: AbortSignal, timeoutMs: number, allowHttpStatuses: number[]) {
    return fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes: WARP_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses });
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const code = encodeURIComponent(number);
    const { response, bytes } = await this.get(`${WARP_TRACKING}${code}?fe=true`, signal, timeoutMs, [404]);
    if (response.status === 200) return parseWarp(jsonOf(bytes, response, 'the shipment'), number);
    // An unknown code gets an empty 404, a route the gateway lacks a 404 with its own sentence. The
    // stops service says in words that it does not know the code.
    if (bytes.length > 0) throw new IndeterminateError(PROVIDER, 'WARP answered the code with an unexplained 404');
    const stops = await this.get(`${WARP_STOPS}${code}/stops`, signal, Math.max(1, deadline - performance.now()), [400, 404]);
    const reply = jsonOf(stops.bytes, stops.response, 'the stops');
    if (stops.response.status === 400 && isRecord(reply) && reply.message === 'Code not found') {
      throw new NotFoundError(PROVIDER, 'WARP has no shipment under this code');
    }
    throw new IndeterminateError(PROVIDER, 'WARP did not say whether it knows this code');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWarpNumber(raw);
    // A read that fails to reach WARP, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WarpTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
