import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { DIRECT_FREIGHT_MAX_BYTES, normalizeDirectFreightNumber, parseDirectFreight, PROVIDER } from './parser.js';

export const DIRECT_FREIGHT_PAGE = 'https://www.directfreight.com.au/ConsignmentStatus.aspx';
export function directFreightUrl(number: string): string {
  return DIRECT_FREIGHT_PAGE + '?' + new URLSearchParams({ lookuptype: '0', consignment_no: normalizeDirectFreightNumber(number) }).toString();
}

export class DirectFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDirectFreightNumber(raw), url = directFreightUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html' } },
        { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DIRECT_FREIGHT_MAX_BYTES,
          redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 403, 404, 410] });
      signal.throwIfAborted();
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Direct Freight refused its public tracking page');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Direct Freight tracking is unavailable', { status: response.status });
      return parseDirectFreight(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'direct-freight-express', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000),
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: DIRECT_FREIGHT_MAX_BYTES, parse: html => parseDirectFreight(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DirectFreightTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent,
    recorder: environment.recorder, trawl: environment.trawl });
  return { id: 'direct-freight-express', recordsSteps: true, steps: ['direct', 'retry', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
