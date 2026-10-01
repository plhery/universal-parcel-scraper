import { isValidS10TrackingNumber } from '../core/detection/s10.js';
import { normalizeTrackingNumber } from '../core/detection/normalize.js';
import { coverageTiers, type CoverageTier } from './coverage.js';
import type { UniversalSource as Source } from './types.js';
export const UNIVERSAL_SOURCES: Source[] = ['ParcelsApp', 'Ship24', '17TRACK', 'UPU'];
/** Providers reached only through the browser service: slower, and sharing one TRAWL. */
export const BROWSER_SOURCES: ReadonlySet<Source> = new Set(['17TRACK', 'Postal Ninja']);

/** Lookup time reserved by the chain and host router, before transport allowance. */
export function universalSourceBudget(source: Source): number {
  return source === 'ParcelsApp' ? 45_000 : source === 'UPU' ? 8_000 : 30_000;
}

/** Evidence-based exception to affinity/rotation, shared by discovery and routing. */
export function priorityUniversalSource(trackingNumber?: string): Source | undefined {
  // E-series and untested formats keep ordinary discovery.
  return trackingNumber && /^[CL][A-Z]\d{9}CN$/.test(normalizeTrackingNumber(trackingNumber)) && isValidS10TrackingNumber(trackingNumber)
    ? '17TRACK' : undefined;
}

export interface UniversalPlan {
  /** The eligible providers, in the order to ask them. */
  sources: Source[];
  /** The carrier whose coverage evidence ordered them, or null for the default order. */
  carrier: string | null;
  /** A provider's coverage tier for that carrier; `unknown` without evidence. */
  tier(source: Source): CoverageTier;
  /** Lower is fuller history for the carrier; providers without evidence share one rank. */
  rank(source: Source): number;
}

const TIER_RANK: Record<CoverageTier, number> = { full: 0, partial: 1, unknown: 2, empty: 3, excluded: 4 };
const tierRank = (tiers: Partial<Record<Source, CoverageTier>> | null, source: Source): number =>
  TIER_RANK[source === 'UPU' ? 'unknown' : tiers?.[source] ?? 'unknown'];

/**
 * Orders providers (given in the default order) by a carrier's coverage tiers:
 * fuller history first, HTTP before the browser service, then the default order.
 * Excluded providers are left out unless nothing else would remain. UPU stays
 * last whatever its evidence: sparse, never a preferred source.
 */
export function orderUniversalSources(eligible: readonly Source[], tiers: Partial<Record<Source, CoverageTier>> | null): Source[] {
  const excluded = (source: Source) => source !== 'UPU' && tiers?.[source] === 'excluded';
  const usable = eligible.some((source) => source !== 'UPU' && !excluded(source)) ? eligible.filter((source) => !excluded(source)) : [...eligible];
  return usable.sort((a, b) => Number(a === 'UPU') - Number(b === 'UPU') || tierRank(tiers, a) - tierRank(tiers, b)
    || Number(BROWSER_SOURCES.has(a)) - Number(BROWSER_SOURCES.has(b)) || eligible.indexOf(a) - eligible.indexOf(b));
}

/**
 * The providers to ask for a number, ordered by the coverage evidence of the
 * first of `carriers` that has some (the carrier the lookup is for, then the one
 * confirmed or discovered for the number), otherwise in the default order.
 */
export function universalPlan(options: {
  carriers?: ReadonlyArray<string | null | undefined>;
  trackingNumber?: string;
  enablePostalNinja?: boolean;
} = {}): UniversalPlan {
  const { trackingNumber, enablePostalNinja = false } = options;
  const defaults: Source[] = enablePostalNinja ? ['ParcelsApp', 'Ship24', 'Postal Ninja', '17TRACK', 'UPU'] : [...UNIVERSAL_SOURCES];
  const eligible = defaults.filter((source) => source !== 'UPU' || trackingNumber === undefined || isValidS10TrackingNumber(trackingNumber));
  const carrier = (options.carriers ?? []).find((candidate) => coverageTiers(candidate)) ?? null;
  const tiers = coverageTiers(carrier);
  const ordered = orderUniversalSources(eligible, tiers);
  const priority = priorityUniversalSource(trackingNumber);
  return {
    sources: priority ? [priority, ...ordered.filter((source) => source !== priority)] : ordered,
    carrier,
    tier: (source) => tiers?.[source] ?? 'unknown',
    rank: (source) => tierRank(tiers, source),
  };
}

/** The default order for a number, without a carrier's evidence. */
export function universalSources(enablePostalNinja = false, trackingNumber?: string): Source[] {
  return universalPlan({ trackingNumber, enablePostalNinja }).sources;
}
