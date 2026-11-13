import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePeninsulaNumber, parsePeninsula, PENINSULA_MAX_BYTES, PROVIDER } from './parser.js';

/** The guest lookup the tracking page at www.peninsulatruck.com/track/ makes for the PRO in its address. */
export const PENINSULA_API = 'https://ptlprodapi.azurewebsites.net/api/track/public';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the lookup answers unknown PROs with a status of its own.
const GONE = [404, 410];
// Bot checks and firewall blocks a CDN could put in place of the reply. The carrier's website
// sits behind a firewall that blocks some countries with such a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|AwsWafIntegration|awswaf\.com|captcha|You have been blocked|barracuda/i;

/** The address of the guest lookup for one whole PRO. */
export function peninsulaLookupUrl(number: string): string {
  return `${PENINSULA_API}/${encodeURIComponent(normalizePeninsulaNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Peninsula answered with a browser check or a block page', { cause });
    throw new SchemaError(PROVIDER, 'Peninsula returned a reply that is not JSON', { cause });
  }
}

export class PeninsulaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePeninsulaNumber(raw);
    const url = peninsulaLookupUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PENINSULA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Peninsula redirected its tracking lookup');
      const body = decodeText(bytes);
      if (GONE.includes(response.status)) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Peninsula answered with a block page');
        throw new TransportError(PROVIDER, 'Peninsula tracking lookup is unavailable');
      }
      return parsePeninsula(json(body), number);
    };
    // A request that fails to reach Peninsula, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'peninsula-truck-lines', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PeninsulaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'peninsula-truck-lines', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
