import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { carrierErrorKind, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { DPDTracker } from '../dpd/adapter.js';
import { JADLOG_PROVIDER, readJadlogSite } from './site.js';

/** The time Jadlog's tracker gets while Geopost can still answer after it. It answers in a second or two. */
const SITE_BEFORE_GROUP_MS = 8_000;

export class JadlogTracker {
  private readonly geopost: DPDTracker;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    // The group's guest service records no steps of its own: it is this lookup's second one.
    this.geopost = new DPDTracker({ country: 'BR', fetcher: options.fetcher, userAgent: options.userAgent });
  }

  /** Jadlog's tracker alone, for a number already reduced to its fourteen digits. */
  private site(number: string, context: { signal: AbortSignal; remainingMs: number }): Promise<CarrierResult> {
    return readJadlogSite(number, { fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal: context.signal,
      timeoutMs: Math.max(1, Math.floor(Math.min(context.remainingMs, SITE_BEFORE_GROUP_MS))) });
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = parcelNumber(raw);
    return runSteps({ carrier: 'jadlog', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{
      id: 'direct',
      run: ({ signal, remainingMs }) => this.site(number, { signal, remainingMs }),
    }, {
      id: 'group',
      // The group's guest service when the tracker does not show the parcel. Its answer is a summary,
      // each milestone once and without places.
      recovers: (error) => !context.signal?.aborted && carrierErrorKind(error) !== null,
      run: async ({ signal, remainingMs, previousError }) => {
        try {
          // The catalog asks for no postcode, so Geopost answers without verifying the recipient.
          return await this.geopost.fetch(number, '', { signal, budgetMs: remainingMs });
        } catch (error) {
          context.signal?.throwIfAborted();
          // A number neither knows is Geopost's answer; a tracker that could not answer stays the failure.
          throw previousError instanceof NotFoundError ? error : previousError;
        }
      },
    }]);
  }

  /**
   * Jadlog's tracker shows only Jadlog's parcels, so one it lists is known. Otherwise Geopost's guest
   * service, which answers for the whole group, knows the parcel only in Brazil.
   */
  async recognize(raw: string, context: TrackingContext = {}) {
    const number = dpdParcelNumber(raw);
    if (!number) return { known: false };
    const started = performance.now();
    const remainingMs = () => Math.max(1, (context.budgetMs ?? 15_000) - (performance.now() - started));
    const signal = context.signal ?? new AbortController().signal;
    const listed = await recognizeFromLookup(() => this.site(number, { signal, remainingMs: remainingMs() })).catch(() => {
      context.signal?.throwIfAborted();
      return { known: false };
    });
    if (listed.known) return listed;
    return { known: await this.geopost.recognizes(number, { signal: context.signal, budgetMs: remainingMs() }) };
  }
}

/** Labels print a check character after the fourteen digits; both sources take the digits. */
function parcelNumber(raw: string): string {
  const number = dpdParcelNumber(raw);
  if (!number) throw new InvalidInputError(JADLOG_PROVIDER, 'Jadlog tracking numbers must contain 14 digits, with or without their check character');
  return number;
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JadlogTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jadlog', recordsSteps: true, steps: ['direct', 'group'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
