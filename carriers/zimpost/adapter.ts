import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZimpostNumber, parseZimpostReply, PROVIDER, ZIMPOST_MAX_BYTES } from './parser.js';

/** The lookup the tracking overlay on Zimpost's home page makes for the code typed in. */
export const ZIMPOST_API = 'https://www.zimpost.co.zw/api/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown item with HTTP 404 and its JSON error, which the parser tells from a missing route.
const NOT_FOUND = 404;

export function zimpostLookupUrl(number: string): string {
  return `${ZIMPOST_API}?${new URLSearchParams({ number })}`;
}

export class ZimpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZimpostNumber(raw);
    // The overlay's own request: the code alone, with no cookie, token, key or browser.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(zimpostLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZIMPOST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, NOT_FOUND] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Zimpost redirected its tracking lookup', { status: response.status });
      return parseZimpostReply(response.status, decodeText(bytes), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'zimpost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZimpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zimpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZimpostNumber(number))),
  };
};
