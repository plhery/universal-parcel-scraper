import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeShipAgentNumber, parseShipAgent, PROVIDER, SHIPAGENT_MAX_BYTES } from './parser.js';

export { normalizeShipAgentNumber, parseShipAgent } from './parser.js';

/** The public tracking API that the tracking page at www.shipagent.in/track/{number} asks. */
export const SHIPAGENT_API = 'https://api.shipagent.in/api/v1/public/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// A challenge page, which can come from Cloudflare in front of the API instead of its reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

/** The API's address for a number, as the page's script builds it. */
export const shipAgentLookupUrl = (number: string): string => `${SHIPAGENT_API}${encodeURIComponent(number)}?source=shipagent.in`;

/** The API's error type in its JSON error reply, if the reply is one. */
function errorType(body: string): string | undefined {
  try {
    const reply: unknown = JSON.parse(body);
    return isRecord(reply) && reply.success === false && isRecord(reply.error) && typeof reply.error.type === 'string' ? reply.error.type : undefined;
  } catch {
    return undefined;
  }
}

export class ShipAgentTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(shipAgentLookupUrl(number), { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHIPAGENT_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
    const body = decodeText(bytes);
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ShipAgent answered with a browser challenge', { status: response.status });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ShipAgent redirected its tracking API', { status: response.status });
    const type = errorType(body);
    if (response.status === 404 && type === 'NOT_FOUND') throw new NotFoundError(PROVIDER, 'ShipAgent has no shipment under this number');
    // A route that is gone, or an error page in its place, is a moved API, not a missing shipment.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'ShipAgent tracking API is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'ShipAgent refused the lookup', { status: 403 });
    if (response.status === 400) throw new IndeterminateError(PROVIDER, 'ShipAgent refused the number', { status: 400 });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(PROVIDER, 'ShipAgent answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'ShipAgent returned a reply that is not JSON', { cause: error });
    }
    return parseShipAgent(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShipAgentNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShipAgentTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
