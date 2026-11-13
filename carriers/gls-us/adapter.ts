import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GLS_US_MAX_BYTES, normalizeGlsUsNumber, parseGlsUs, PROVIDER } from './parser.js';

// The client of GLS's US tracking page (gls_group_common_js.js) posts the number here, with no
// credential, cookie or token, and the page's language as it names it.
export const GLS_US_ENDPOINT = 'https://connect.gls-us.com/api/public/tracking/TrackShipmentSummariesByTrackingNumbers';
const PAGE_ORIGIN = 'https://gls-group.com';
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-turnstile|_cf_chl_opt|captcha|The request is blocked/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes).replace(/^\uFEFF/, '');
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'GLS US returned an empty reply');
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GLS US answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'GLS US returned a reply that is not JSON', { cause });
  }
}

export class GlsUsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGlsUsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      const { response, bytes } = await fetchBounded(GLS_US_ENDPOINT, {
        method: 'POST', signal,
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': 'en-CA',
          Origin: PAGE_ORIGIN, Referer: `${PAGE_ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
        },
        body: JSON.stringify({ trackingNumbers: number, isFreight: false }),
      }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: GLS_US_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [404, 410] });
      // The not-found answer is a 200 with an empty list; a 404 is a missing route, not a missing parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'GLS US could not return the tracking resource', { status: response.status });
      return parseGlsUs(json(bytes), number);
    };
    return runSteps({ carrier: 'gls-us', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GlsUsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gls-us', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGlsUsNumber(number))) };
};
