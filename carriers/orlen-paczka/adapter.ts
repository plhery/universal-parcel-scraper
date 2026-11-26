import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOrlenPaczkaNumber, ORLEN_PACZKA_MAX_BYTES, parseOrlenPaczka, PROVIDER } from './parser.js';

// The status service the tracking page at www.orlenpaczka.pl/sledz-paczke/ calls.
const ENDPOINT = 'https://nadaj.orlenpaczka.pl/parcel/api-status';

export class OrlenPaczkaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeOrlenPaczkaNumber(raw);
    return runSteps({ carrier: 'orlen-paczka', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${ENDPOINT}?${new URLSearchParams({ id: number })}`, { signal,
        headers: { Accept: '*/*', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: ORLEN_PACZKA_MAX_BYTES,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher,
      });
      // A missing endpoint says nothing about the parcel.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'ORLEN Paczka tracking endpoint is unavailable');
      return parseOrlenPaczka(decodeText(bytes), number);
    } }]);
  }
}

/** Whether the failure is error 1004: the status service holds the number and shows no tracking for it. */
function withheld(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1, current = current.cause) {
    if (current instanceof CarrierError) return current.kind === 'indeterminate' && current.reason === 'tracking_withheld';
  }
  return false;
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OrlenPaczkaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'orlen-paczka', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: async (number, context) => {
      try {
        return await recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeOrlenPaczkaNumber(number)));
      } catch (error) {
        // Error 1004 answers only a number with its own check digit in the issued range; a wrong
        // check digit or a number past the range gets the no-data placeholder. ORLEN holds it.
        if (withheld(error)) return { known: true, lastActivityAt: null };
        throw error;
      }
    } };
};
