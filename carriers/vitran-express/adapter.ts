import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isVitranChallenge, normalizeVitranNumber, parseVitran, PROVIDER, VITRAN_MAX_BYTES, vitranQuickTrackUrl } from './parser.js';

export { VITRAN_QUICK_TRACK, vitranQuickTrackUrl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class VitranTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeVitranNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'vitran-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** One GET of the Quick Track page for the number, which renders the answer; no cookie, form post or browser. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(vitranQuickTrackUrl(number), {
      method: 'GET', signal,
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-CA,en;q=0.8', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: VITRAN_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const body = decodeText(bytes);
    if (response.status === 403) {
      throw new ChallengeError(PROVIDER, isVitranChallenge(body) ? 'Vitran answered with a browser check' : 'Vitran refused the lookup',
        { status: 403 });
    }
    // A moved or missing page is no answer about the shipment.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Vitran moved its Quick Track page');
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, "Vitran's Quick Track page is unavailable");
    return parseVitran(body, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VitranTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vitran-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeVitranNumber(number))),
  };
};
