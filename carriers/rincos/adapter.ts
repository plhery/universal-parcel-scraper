import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { normalizeRincosNumber, parseRincos, PROVIDER, RINCOS_MAX_BYTES } from './parser.js';

export const RINCOS_TRACKING_PAGE = 'https://www.rincos.asia/out/TraceInfo_kr.do';
const MOVED = [301, 302, 303, 307, 308, 404, 410];

export class RincosTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeRincosNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = new URL(RINCOS_TRACKING_PAGE);
      url.search = new URLSearchParams({ SCGBN: '20', P_VAL: number }).toString();
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: RINCOS_MAX_BYTES, redirect: 'manual', allowHttpStatuses: MOVED });
      signal.throwIfAborted();
      if (MOVED.includes(response.status)) throw new TransportError(PROVIDER, 'Rincos tracking endpoint is unavailable', { status: response.status });
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Rincos returned no tracking page', { status: response.status });
      return parseRincos(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'rincos', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RincosTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'rincos', steps: ['direct', 'retry'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
