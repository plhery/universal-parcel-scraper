import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  AZERPOST_LOOKUP, AZERPOST_MAX_BYTES, AZERPOST_ORIGIN, AZERPOST_PAGE, isAzerpostBlocked, normalizeAzerpostNumber, parseAzerpost, PROVIDER,
} from './parser.js';

export { AZERPOST_LOOKUP, AZERPOST_PAGE, normalizeAzerpostNumber, parseAzerpost } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A moved or removed route; the tracker answers an unknown number itself, with HTTP 200.
const GONE = [404, 405, 410];
// Laravel's answer to a request whose session token it refuses.
const EXPIRED = 419;
const DEFAULT_BUDGET_MS = 15_000;

export class AzerpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAzerpostNumber(raw);
    // A read that fails to reach the tracker, or hangs, gets one more try: the first gets half of
    // the budget, so the retry fits in the rest. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: 'azerpost', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /**
   * The multipart form the page's script posts. The script first asks `/api/get-csrf` for the
   * session's token and reCAPTCHA for one of its own, but the lookup checks neither, nor a
   * cookie: the number and an empty reCAPTCHA field are enough.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const body = new FormData();
    body.append('package_id', number);
    body.append('g_token', '');
    const { response, bytes } = await fetchBounded(AZERPOST_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json', Origin: AZERPOST_ORIGIN, Referer: AZERPOST_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AZERPOST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, EXPIRED] });
    const text = decodeText(bytes);
    // A firewall sits in front of the site; its block page can come with HTTP 200.
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Azerpost refused the lookup', { status: 403 });
    if (response.status === EXPIRED) throw new ChallengeError(PROVIDER, "Azerpost asked for the page's session token", { status: EXPIRED });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Azerpost tracking is unavailable', { status: response.status });
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (isAzerpostBlocked(text)) throw new ChallengeError(PROVIDER, 'Azerpost answered with a block page');
      throw new SchemaError(PROVIDER, 'Azerpost answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'Azerpost returned a reply that is not JSON', { cause: error });
    }
    return parseAzerpost(payload, number);
  }
}

// No recognition: no detection rule offers Azerpost for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new AzerpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'azerpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
