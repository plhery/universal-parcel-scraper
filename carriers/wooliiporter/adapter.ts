import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeWooliiNumber, parseWoolii, PROVIDER, WOOLII_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on woolii.com makes for one number. */
export const WOOLII_API = 'https://woolii.com/api/public/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|Vercel Security Checkpoint/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'WooliiPorter answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'WooliiPorter returned a reply that is not JSON', { cause });
  }
}

// The service's error for a number it does not know.
const NOT_FOUND = /^Tracking (?:number )?not found$/;

export class WooliiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWooliiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${WOOLII_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: WOOLII_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status) || response.status === 410) throw new TransportError(PROVIDER, 'WooliiPorter tracking lookup moved');
      const payload = json(decodeText(bytes));
      // An unknown number is HTTP 404 with the service's own error, in either of its wordings; any other 404 is a moved route.
      if (response.status === 404) {
        const error = payload !== null && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
        if (typeof error === 'string' && NOT_FOUND.test(error)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'WooliiPorter tracking lookup is unavailable');
      }
      return parseWoolii(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'wooliiporter', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WooliiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'wooliiporter', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeWooliiNumber(number))),
  };
};
