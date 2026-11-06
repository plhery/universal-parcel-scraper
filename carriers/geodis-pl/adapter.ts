import type { AdapterFactory, Recognition, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  GEODIS_PL_MAX_BYTES, normalizeGeodisPlNumber, parseGeodisPlHistory, parseGeodisPlSummary, PROVIDER,
} from './parser.js';

/** The tracker's English page. Its search form posts, and the page answers the same search as a plain GET. */
export const GEODIS_PL_PAGE = 'https://strefaklienta.pekaes.geodis.pl/en/';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;

/** The search page for one number, as a person can open it. */
export function geodisPlSearchUrl(number: string): string {
  return `${GEODIS_PL_PAGE}?${new URLSearchParams({ ShNumber: normalizeGeodisPlNumber(number) })}`;
}

/** The history the page's "Details" link loads. */
export function geodisPlHistoryUrl(number: string): string {
  return `${GEODIS_PL_PAGE}?${new URLSearchParams({ ltlHistory: normalizeGeodisPlNumber(number) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GEODIS Poland answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GEODIS Poland returned a history that is not JSON', { cause });
  }
}

type Get = (url: string, accept: string, headers?: Record<string, string>) => Promise<string>;

export class GeodisPlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGeodisPlNumber(raw);
    return this.run(context, async (get) => {
      const summary = parseGeodisPlSummary(await get(geodisPlSearchUrl(number), 'text/html'), number);
      // The page's own request for the history, as its jQuery sends it.
      const history = await get(geodisPlHistoryUrl(number), 'application/json, text/javascript, */*; q=0.01',
        { 'X-Requested-With': 'XMLHttpRequest' });
      return parseGeodisPlHistory(json(history), summary, Date.now());
    });
  }

  /**
   * Whether the tracker knows the shipment, from the search page alone. The
   * summary names the number, and the page answers a number it does not know
   * with its own notice, so a summary is the shipment, scanned or not.
   * Reading the history too doubles the wait, which the first half of a short
   * recognition budget does not always cover.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    let number: string;
    try {
      number = normalizeGeodisPlNumber(raw);
    } catch {
      return { known: false };
    }
    try {
      await this.run(context, async (get) => parseGeodisPlSummary(await get(geodisPlSearchUrl(number), 'text/html'), number));
    } catch (error) {
      if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
      throw error;
    }
    return { known: true, lastActivityAt: null };
  }

  /** One read of the site: a try with half of the budget, then one more when it fails to reach the site or hangs. */
  private run<T>(context: TrackingContext, read: (get: Get) => Promise<T>): Promise<T> {
    const budgetMs = context.budgetMs ?? 15_000;
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<T> => {
      const deadline = performance.now() + timeoutMs;
      const get: Get = async (url, accept, headers = {}) => {
        // A request out of time fails as a timeout, which the retry step may take up.
        const left = Math.max(1, Math.floor(deadline - performance.now()));
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          ...headers, Accept: accept, 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: left, maxBytes: GEODIS_PL_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
        // A moved or missing page says nothing about the shipment.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'GEODIS Poland tracking page is unavailable');
        return decodeText(bytes);
      };
      return read(get);
    };
    return runSteps({ carrier: 'geodis-pl', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GeodisPlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'geodis-pl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
