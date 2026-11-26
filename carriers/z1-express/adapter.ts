import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZ1Number, parseZ1, PROVIDER, Z1_MAX_BYTES } from './parser.js';

export { normalizeZ1Number, parseZ1 } from './parser.js';

/**
 * The tracking page of Z1's site, which its form posts the numbers to and which reads them
 * from the address too. The site answers plain HTTP: its HTTPS port serves another host's
 * expired certificate.
 */
export const Z1_TRACKER = 'http://www.z1express.com/index.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The tracking page's address for one number. */
export const z1TrackerUrl = (number: string): string =>
  `${Z1_TRACKER}?${new URLSearchParams({ m: 'home', c: 'Search', a: 'track', trackNumber: number })}`;

export class Z1Tracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(z1TrackerUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: Z1_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Z1 Express refused its guest request');
    // An unknown number is HTTP 200 too; a redirect or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Z1 Express tracking page moved', { status: response.status });
    if (!/^text\/html\b/i.test(response.headers.get('content-type') ?? 'text/html')) {
      throw new SchemaError(PROVIDER, 'Z1 Express answered with something other than its tracking page');
    }
    return parseZ1(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZ1Number(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Z1Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
