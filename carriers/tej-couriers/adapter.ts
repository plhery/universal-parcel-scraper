import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTejNumber, parseTej, PROVIDER, TEJ_MAX_BYTES } from './parser.js';

/** The lookup the tracking page makes for one consignment number. */
export const TEJ_TRACKING_URL = 'https://www.tejcouriers.com/api/tracking/php/tracking.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|Not Acceptable)|_Incapsula_Resource|AwsWafIntegration|Mod_Security|captcha/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Tej Couriers answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Tej Couriers returned a reply that is not JSON', { cause });
  }
}

export class TejTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTejNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tej-couriers', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${TEJ_TRACKING_URL}?${new URLSearchParams({ tracking: number })}`, {
      method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9',
        Referer: 'https://www.tejcouriers.com/shipment-tracking.php', 'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, timeoutMs, maxBytes: TEJ_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 406, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Tej Couriers moved its tracking service');
    // The site's firewall refuses some clients with 406, whatever the number.
    if (response.status === 406) throw new ChallengeError(PROVIDER, 'Tej Couriers refused the request', { status: 406 });
    // An unknown number is HTTP 200 with the service's own answer; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Tej Couriers tracking service is unavailable');
    return parseTej(json(bytes), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TejTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tej-couriers', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTejNumber(number))),
  };
};
