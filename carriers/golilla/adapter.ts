import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GOLILLA_MAX_BYTES, normalizeGolillaNumber, parseGolilla, PROVIDER } from './parser.js';

export { parseGolilla } from './parser.js';

/** The lookup the tracking page on my.golilla.it makes for a shipment number. */
export const GOLILLA_API = 'https://tms.golilla.it/ope/rest/tracking/';
const REFERER = 'https://my.golilla.it/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The status SafeLine, the firewall in front of the lookup, answers with its browser check.
const SAFELINE_CHECK = 468;
// Bot checks that could stand in place of the reply: SafeLine's, DataDome's on the tracking page, or a CDN's.
const CHALLENGE = /safeline|<title>\s*Controllo di Sicurezza|captcha-delivery\.com|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Golilla answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Golilla returned a reply that is not JSON', { cause });
  }
}

/** The service's own answer for a number it does not know: HTTP 404 with this body. */
export function isGolillaNotFound(payload: unknown): boolean {
  return isRecord(payload) && isRecord(payload.status) && payload.status.code === 404
    && /^spedizione non trovata$/i.test(clean(payload.status.message, 100));
}

export class GolillaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGolillaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${GOLILLA_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', Referer: REFERER, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GOLILLA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, SAFELINE_CHECK] });
      signal.throwIfAborted();
      if (response.status === SAFELINE_CHECK) throw new ChallengeError(PROVIDER, 'Golilla answered with its firewall\'s browser check', { status: SAFELINE_CHECK });
      if (response.status === 404) {
        let body: unknown;
        try {
          body = JSON.parse(decodeText(bytes));
        } catch {
          body = null;
        }
        if (isGolillaNotFound(body)) throw new NotFoundError(PROVIDER);
      }
      // Any other 404, a 410 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Golilla tracking lookup is unavailable', { status: response.status });
      return parseGolilla(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'golilla', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GolillaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'golilla', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
