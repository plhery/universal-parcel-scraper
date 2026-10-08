/**
 * The universal discovery chain: what runs when no dedicated carrier adapter
 * can answer for a parcel.
 *
 * Default order is ParcelsApp -> Ship24 -> 17TRACK -> UPU, with Postal Ninja after
 * the other aggregators only when the host enables it. A carrier with coverage
 * evidence (coverage.ts) gets its own order: fuller history first, HTTP before the
 * browser service within a tier, providers that answered with another parcel or
 * refused the format left out, Postal Ninja still after the other aggregators.
 * Validated China Post C/L numbers put 17TRACK first. Each provider is asked
 * once per lookup and the first usable history wins; the per-parcel router
 * remembers which provider answered, except UPU stays last and requires a
 * postal S10. The source names are persisted in routing state and must not change.
 *
 * This module owns the order and the aggregate failure; every protocol detail
 * lives in the provider folder next to it.
 */
import type { AdapterEnvironment, CarrierAdapter, TrackingContext } from '../core/adapter/index.js';
import { uspsPackageIdentifier } from '../core/detection/usps.js';
import { BudgetExceededError, IndeterminateError } from '../core/errors/index.js';
import type { CarrierResult } from '../core/result/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/index.js';
import { adapter as parcelsAppAdapter } from './parcelsapp/adapter.js';
import { adapter as postalNinjaAdapter } from './postal-ninja/adapter.js';
import { adapter as seventeenTrackAdapter } from './seventeentrack/adapter.js';
import { adapter as ship24Adapter } from './ship24/adapter.js';
import { adapter as upuAdapter } from './upu/adapter.js';
import { numberOf, type UniversalSource as Source } from './shared/result.js';

export { parse17TrackResponse, SeventeenTrackLookupError, SeventeenTrackNoHistoryError, SeventeenTrackVerificationError } from './seventeentrack/adapter.js';
export { parseParcelsAppHtml, parseParcelsAppResponse } from './parcelsapp/adapter.js';
export { parsePostalNinjaResponse } from './postal-ninja/adapter.js';
export { parseShip24Response } from './ship24/adapter.js';
export { TrackingCaptureError } from './shared/capture.js';
export type { UniversalSource } from './shared/result.js';

export * from './plan.js';
import { universalSources, universalSourceBudget } from './plan.js';

/**
 * A source is asked only with this much budget left. A provider that runs out
 * of time returns a few milliseconds before the deadline, because its timers
 * round down to whole milliseconds, and none answers in less.
 */
const MIN_SOURCE_BUDGET_MS = 50;

const FACTORIES = {
  'Ship24': ship24Adapter,
  'ParcelsApp': parcelsAppAdapter,
  'Postal Ninja': postalNinjaAdapter,
  '17TRACK': seventeenTrackAdapter,
  'UPU': upuAdapter,
} as const satisfies Record<Source, unknown>;

interface SourceFailure {
  source: Source;
  reason: string;
  error: unknown;
}

export class UniversalTrackingError extends AggregateError {
  constructor(readonly failures: ReadonlyArray<SourceFailure>) {
    super(failures.map(({ error }) => error), `Automatic carrier lookup could not retrieve tracking history. ${failures.map(
      ({ source, reason }) => `${source}: ${reason}`,
    ).join('; ')}`);
    this.name = 'UniversalTrackingError';
  }
}

export interface UniversalTrackerOptions {
  providers?: readonly Source[];
  /** The browser service endpoint; overrides `environment.trawl`. An empty string disables it. */
  trawlUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  executablePath?: string;
  enablePostalNinja?: boolean;
  /** Test seam replacing the two local-browser providers. */
  browserLookup?: (source: 'Postal Ninja' | 'Ship24', number: string) => Promise<CarrierResult>;
  /** What the host gives every adapter: browser service, telemetry sink, flags. */
  environment?: Partial<AdapterEnvironment>;
}

export class UniversalTracker {
  private readonly instances = new Map<Source, CarrierAdapter>();
  constructor(readonly options: UniversalTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('Universal tracking timeout must be positive');
    }
  }

  /**
   * Look up one number through the whole chain. `postcode` is the parcel's
   * stored delivery postcode, if the user supplied one: it is forwarded into
   * every provider's track input. ParcelsApp submits it as extra[zipcode] on
   * its direct API request; 17TRACK submits it through the browser's postcode form.
   * `countryHint` is accepted for compatibility and no longer read.
   * The caller's budget covers the whole chain and its signal ends it.
   */
  async fetch(trackingNumber: string, postcode?: string | null, context: TrackingContext = {}, countryHint?: string | null): Promise<CarrierResult> {
    numberOf(trackingNumber);
    context.signal?.throwIfAborted();
    const deadline = context.budgetMs === undefined ? Infinity : performance.now() + context.budgetMs;
    const failures: SourceFailure[] = [];
    const sources = universalSources(this.options.enablePostalNinja, trackingNumber).filter(source => (this.options.providers ?? ['UPU']).includes(source));
    for (const source of sources) {
      const remaining = deadline - performance.now();
      if (remaining < MIN_SOURCE_BUDGET_MS) {
        failures.push({ source, reason: 'the lookup budget was spent first', error: new BudgetExceededError(source, context.budgetMs!) });
        continue;
      }
      try {
        return await this.fetchSource(source, trackingNumber, Math.min(remaining, this.options.timeoutMs ?? universalSourceBudget(source)),
          postcode, null, context.signal, countryHint);
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason;
        failures.push({ source, reason: 'history unavailable; try again later or open the tracking website', error });
      }
    }
    throw new UniversalTrackingError(failures);
  }

  async fetchSource(source: Source, trackingNumber: string, timeoutMs = this.options.timeoutMs ?? universalSourceBudget(source), postcode?: string | null, timezone?: string | null, signal?: AbortSignal, countryHint?: string | null): Promise<CarrierResult> {
    const typed = numberOf(trackingNumber);
    // A USPS routing barcode opens with the recipient's ZIP code. Providers are
    // asked for the package identifier after it, the number USPS tracks, and
    // bind their answer to it. Detection still reads the barcode as typed.
    const number = uspsPackageIdentifier(typed) ?? typed;
    const result = this.options.browserLookup && (source === 'Postal Ninja' || source === 'Ship24')
      ? await this.options.browserLookup(source, number)
      : await this.provider(source).track({ number, postcode: postcode ?? null, timezone: timezone ?? null, countryHint: countryHint ?? null }, { budgetMs: timeoutMs, signal });
    // A history whose scans all lack an instant can't be placed on a timeline or weighed
    // against another provider's, so it isn't an answer. An answer without scans keeps
    // its stage and carrier as before. UPU's local clocks are by design.
    if (source !== 'UPU' && result.events?.length && !result.events.some((event) => event.time)) {
      throw new IndeterminateError(source, 'No dated tracking events', { reason: 'undated_history' });
    }
    return result;
  }

  /** One provider adapter, built from this tracker's environment. */
  private provider(source: Source): CarrierAdapter {
    let instance = this.instances.get(source);
    if (!instance) { instance = FACTORIES[source](this.environment()); this.instances.set(source, instance); }
    return instance;
  }

  private environment(): AdapterEnvironment {
    const partial = this.options.environment ?? {};
    const fetcher = partial.fetcher ?? this.options.fetcher;
    return {
      fetcher,
      userAgent: partial.userAgent,
      trawl: this.trawl(fetcher, partial),
      browserExecutablePath: partial.browserExecutablePath ?? this.options.executablePath ?? null,
      recorder: partial.recorder ?? NOOP_RECORDER,
      env: partial.env ?? {},
    };
  }

  private trawl(fetcher: typeof fetch | undefined, partial: Partial<AdapterEnvironment>): TrawlClient | null {
    const configured = this.options.trawlUrl;
    if (configured !== undefined) return configured ? new TrawlClient(configured, fetcher) : null;
    if (partial.trawl !== undefined) return partial.trawl;
    return TrawlClient.fromEnvironment(partial.env ?? {}, fetcher);
  }
}
