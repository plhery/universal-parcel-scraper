import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  INPOSDOM_FORM, INPOSDOM_MAX_BYTES, INPOSDOM_ORIGIN, INPOSDOM_SEARCH, isInposdomBlocked, normalizeInposdomNumber, parseInposdom, PROVIDER,
} from './parser.js';

export { INPOSDOM_FORM, INPOSDOM_SEARCH } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class InposdomTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeInposdomNumber(raw);
    // A read that fails to reach the tracker, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status or a reply is never sent again.
    return runSteps({ carrier: 'inposdom', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** The tracker's form, posted with the number as the page posts it; it needs no session or token. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(INPOSDOM_SEARCH, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-DO,es;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded', Origin: INPOSDOM_ORIGIN, Referer: INPOSDOM_FORM,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ buscar: number, buscador: 'BUSCAR' }).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: INPOSDOM_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503],
    });
    // Cloudflare fronts the tracker; its browser check comes back with HTTP 403 or 503.
    if (response.status === 403 || response.status === 503) {
      const challenged = response.headers.get('cf-mitigated') === 'challenge' || isInposdomBlocked(decodeText(bytes));
      if (challenged) throw new ChallengeError(PROVIDER, 'INPOSDOM answered with a browser check', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'INPOSDOM refused the lookup', { status: 403 });
    }
    // The tracker answers every search with HTTP 200; a redirect or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'INPOSDOM tracking is unavailable', { status: response.status });
    return parseInposdom(decodeText(bytes), number);
  }
}

// No recognition: no detection rule offers INPOSDOM for a number, so preflight
// never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new InposdomTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'inposdom', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
