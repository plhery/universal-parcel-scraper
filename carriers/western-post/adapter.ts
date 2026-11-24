import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isWesternPostBlocked, normalizeWesternPostNumber, parseWesternPost, PROVIDER, WESTERN_POST_MAX_BYTES, westernPostJson,
} from './parser.js';

export { normalizeWesternPostNumber, parseWesternPost } from './parser.js';

/** The home page, which holds the tracking box and the script that asks the tracker. */
export const WESTERN_POST_PAGE = 'https://www.wpglb.com/';
/** The tracker the page's script posts the numbers to. */
export const WESTERN_POST_TRACK = 'https://www.wpglb.com/trackQuery';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/**
 * The form the page's script posts: the numbers typed in, joined by commas, as
 * `trackNumberList`. The adapter sends one number.
 */
export function westernPostLookupBody(number: string): string {
  return new URLSearchParams({ trackNumberList: number }).toString();
}

export class WesternPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(WESTERN_POST_TRACK, { method: 'POST', signal, headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.wpglb.com', Referer: WESTERN_POST_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: westernPostLookupBody(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: WESTERN_POST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 403 || status === 503) {
      if (isWesternPostBlocked(body)) throw new ChallengeError(PROVIDER, 'Western Post answered with a browser check', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Western Post refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Western Post tracking is unavailable', { status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (isWesternPostBlocked(body)) throw new ChallengeError(PROVIDER, 'Western Post answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Western Post answered with a page instead of its tracking reply');
    }
    return parseWesternPost(westernPostJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWesternPostNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: WooliiPorter prints the same WP and thirteen digits, and no
// detection rule offers Western Post, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new WesternPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
