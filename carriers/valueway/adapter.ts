import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import {
  normalizeValuewayNumber, PROVIDER, VALUEWAY, VALUEWAY_API, VALUEWAY_PAGE_MAX_BYTES, VALUEWAY_SITE, valuewayHandoff, valuewayPageUrl,
  withoutReference,
} from './parser.js';

export { VALUEWAY_API, VALUEWAY_SITE, valuewayPageUrl } from './parser.js';

const BUDGET_MS = 15_000;
// The page names the delivery carrier only; it waits for no more than this, and is not asked with less left.
const PAGE_TIMEOUT_MS = 6_000;
const PAGE_MIN_MS = 1_000;

/** The record the tracking server gives for one number. */
export function valuewayLookupUrl(number: string): string {
  return ginfoLookupUrl(VALUEWAY_API, number);
}

type Options = { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string };

/**
 * Valueway Express's tracker: the server's record of the waybill, then the
 * tracking page the site opens for it, whose script names the domestic
 * courier and its number. The page adds the delivery carrier and nothing
 * else, so a page that fails leaves the record as it is.
 */
export class ValuewayTracker {
  private readonly records: GinfoTracker;

  constructor(private readonly options: Options = {}) {
    this.records = new GinfoTracker(VALUEWAY, options);
  }

  /** The record alone, as recognition reads it. */
  async record(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return withoutReference(await this.records.fetch(raw, context));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeValuewayNumber(raw);
    const budget = lookupBudget(context, BUDGET_MS, PROVIDER);
    const result = await this.record(number, { signal: budget.signal, budgetMs: budget.remainingMs() });
    return { ...result, ...(await this.handoff(number, budget, context.signal)) };
  }

  private async handoff(number: string, budget: LookupBudget, caller: AbortSignal | undefined): Promise<Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>> {
    const remaining = budget.remainingMs();
    if (remaining < PAGE_MIN_MS) return {};
    try {
      const { response, bytes } = await fetchBounded(valuewayPageUrl(number), { method: 'GET', signal: budget.signal, headers: {
        Accept: 'text/html, */*', Referer: VALUEWAY_SITE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: VALUEWAY_PAGE_MAX_BYTES,
        timeoutMs: Math.min(PAGE_TIMEOUT_MS, remaining), redirect: 'manual' });
      // The page is written in GB2312.
      return response.status === 200 ? valuewayHandoff(decodeText(bytes, 'gb18030'), number) : {};
    } catch {
      // The caller's cancellation stops the lookup; any other failure leaves the record without a delivery carrier.
      caller?.throwIfAborted();
      return {};
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ValuewayTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: VALUEWAY.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The record says whether the tracker holds the waybill; the page is not asked.
    recognize: (number, context) => recognizeFromLookup(() => tracker.record(number, context),
      () => accepted(() => normalizeValuewayNumber(number))),
  };
};
