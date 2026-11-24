import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAX_BYTES, normalizeCtlGroupNumber, parseCtlGroup, PROVIDER } from './parser.js';

export { normalizeCtlGroupNumber, parseCtlGroup } from './parser.js';

/**
 * The tracking page for a waybill number. The server renders the lookup into the page, as it
 * does after its form's post, without the form's session token.
 */
export const ctlGroupTrackingUrl = (number: string): string => `https://www.ctlgroup.pl/tracking/${encodeURIComponent(number)}`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number with HTTP 200 and a notice; a 404 or 410 is a moved route.
const GONE = [404, 410];

export class CtlGroupTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCtlGroupNumber(raw);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pl,en;q=0.8', 'User-Agent': userAgentOf(this.options.userAgent) };
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(ctlGroupTrackingUrl(number), { method: 'GET', signal, headers }, {
        provider: PROVIDER, timeoutMs, maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE],
        fetcher: this.options.fetcher });
      const { status } = response;
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'CTL Group’s tracking page is unavailable', { status });
      return parseCtlGroup(decodeText(bytes), number);
    };
    // A lookup that fails to reach CTL Group, or hangs, gets one more: the first gets half of the
    // budget, so the retry fits in the rest.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CtlGroupTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
