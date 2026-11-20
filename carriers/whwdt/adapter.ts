import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ITDIDA_BUSY, ITDIDA_REDIRECTS, itdidaJson, itdidaLookupUrl, itdidaUnavailable } from './itdida.js';
import { CARRIER, normalizeWhwdtNumber, parseWhwdt, PROVIDER, WHWDT_MAX_BYTES } from './parser.js';

/** The ITDIDA tenant the forwarder's site links to for order lookups. */
export const WHWDT_HOST = 'hyd.itdida.com';

export class WhwdtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeWhwdtNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The tracking page's lookup: the number alone, with no session, token or key.
      const { response, bytes } = await fetchBounded(itdidaLookupUrl(WHWDT_HOST, number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: WHWDT_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...ITDIDA_REDIRECTS, 404, 410, ITDIDA_BUSY] });
      // A busy tenant answers 503 in JSON, read as a rate limit; a 503 without it is maintenance.
      if (response.status === ITDIDA_BUSY) itdidaUnavailable(decodeText(bytes), PROVIDER);
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Wuhan Wodetong tracking lookup is unavailable', { status: response.status });
      return parseWhwdt(itdidaJson(decodeText(bytes), PROVIDER), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WhwdtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeWhwdtNumber(number))),
  };
};
