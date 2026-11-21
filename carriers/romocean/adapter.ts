import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseRomocean, PROVIDER, ROMOCEAN_MAX_BYTES, ROMOCEAN_PAGE_SIZE, romoceanBill, romoceanResult } from './parser.js';

/** The Romeu group's portal, whose movement search Romocean's tracking page embeds. */
export const ROMOCEAN_PORTAL = 'https://shippy.romeushipping.com';
/** The portal's search, which answers a bill with its containers and their histories. */
export const ROMOCEAN_TRACKER = 'https://shippy-api.romeushipping.com/api/Romocean/GetFiltered';
// The search's type for a bill of lading.
const BILL_SEARCH = 1;
// A bot check a CDN could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|<title>\s*Attention Required/i;

export class RomoceanTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const bill = romoceanBill(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(ROMOCEAN_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        Origin: ROMOCEAN_PORTAL, Referer: `${ROMOCEAN_PORTAL}/`,
      }, body: JSON.stringify({ searchMovementType: BILL_SEARCH, searchMovementValueList: [bill], paginationInfo: {
        page: 1, take: ROMOCEAN_PAGE_SIZE, countTotal: null, pageTotal: null, orderBy: 'containerCode', orderByDirection: 'd',
      } }) }, { provider: PROVIDER, timeoutMs, maxBytes: ROMOCEAN_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [403, 404, 429], fetcher: this.options.fetcher });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Romocean refused the search', { status: response.status });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Romocean\'s search is unavailable', { status: response.status });
      return romoceanResult(parseRomocean(text, bill));
    };
    // A search that fails to reach the portal, or hangs, gets one more: the first gets half
    // of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'romocean', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RomoceanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'romocean', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
