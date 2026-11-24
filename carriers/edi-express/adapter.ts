import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EDI_LOOKUP, EDI_MAX_BYTES, isEdiBlocked, normalizeEdiNumber, parseEdiExpress, PROVIDER } from './parser.js';

export { EDI_LOOKUP, normalizeEdiNumber, parseEdiExpress } from './parser.js';

const TRACE_PAGE = 'https://my.ediexpressinc.com/pro_pu_trace.asp';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the page answers an unknown PRO with a notice.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class EdiExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the trace page's PRO form makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(EDI_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', Referer: TRACE_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ p: number, Submit: 'Trace' }).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EDI_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 401, 403, 503],
    });
    const { status } = response;
    // The page declares Latin-1.
    const html = decodeText(bytes, 'iso-8859-1');
    if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'EDI Express refused the lookup', { status });
    if (status === 503) {
      if (isEdiBlocked(html)) throw new ChallengeError(PROVIDER, 'EDI Express answered with a block page', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if (REDIRECTS.includes(status)) throw new TransportError(PROVIDER, 'EDI Express redirected its PRO lookup', { status });
    if (GONE.includes(status)) throw new TransportError(PROVIDER, 'EDI Express shipment details are unavailable', { status });
    if (!html.trim()) throw new IndeterminateError(PROVIDER, 'EDI Express returned an empty page');
    return parseEdiExpress(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEdiNumber(raw);
    // A post that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a page is never sent again.
    return runSteps({ carrier: 'edi-express', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: nine digits are shared by many carriers and no rule offers EDI Express, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new EdiExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'edi-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
