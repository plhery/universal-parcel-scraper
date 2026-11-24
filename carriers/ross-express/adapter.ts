import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRossNumber, parseRossTrace, PROVIDER, ROSS_MAX_BYTES } from './parser.js';

export { normalizeRossNumber, parseRossTrace } from './parser.js';

/** The XML shipment trace behind Ross Express's tracker on Carrier Logistics, open without a login. */
export const ROSS_TRACE = 'https://tracking.carrierlogistics.com/scripts/rxic.pol/protracexml.htm';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the trace names an unknown PRO in a 200 reply.
const GONE = [404, 410];

/** The trace's address for one PRO. */
export function rossTraceUrl(pro: string): string {
  return `${ROSS_TRACE}?${new URLSearchParams({ pronum: pro })}`;
}

export class RossTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const pro = normalizeRossNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(rossTraceUrl(pro), { signal, headers: {
        Accept: 'text/xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ROSS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Ross Express redirected its shipment trace', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Ross Express shipment trace is unavailable', { status: response.status });
      // The trace labels its replies ISO-8859-1, which browsers read as windows-1252.
      const xml = decodeText(bytes, 'windows-1252');
      if (!xml.trim()) throw new IndeterminateError(PROVIDER, 'Ross Express returned an empty reply');
      return parseRossTrace(xml, pro);
    };
    // A read that fails to reach the tracker, or hangs, is sent once more: the first gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: Ross's seven digits are a shape many carriers share, so no rule offers it to preflight.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RossTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
