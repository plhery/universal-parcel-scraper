import { isValidS10TrackingNumber } from '../core/detection/s10.js';
import { normalizeTrackingNumber } from '../core/detection/normalize.js';
import { CARRIER_IDS } from '../generated/catalog.js';
import { coverageTiers, type CoverageTier, type ObservedCoverage } from './coverage.js';
import { linkTokenKept, numberIsLinkToken } from './linkToken.js';
import { ordertrackerFeeds } from './ordertracker/feeds.js';
import { track123CourierCode } from './track123/couriers.js';
import type { UniversalSource as Source } from './types.js';

export type { ObservedCoverage } from './coverage.js';

/** What routing knows of a provider, whatever the carrier. */
export interface UniversalProvider {
  /** `browser` lookups go through the browser service: slower, and sharing one TRAWL. */
  transport: 'http' | 'browser';
  /** An HTTP provider that answers seconds later, as the browser ones do. */
  slow?: boolean;
  /** Lookup time reserved by the chain and host router, before transport allowance. */
  budgetMs: number;
  /**
   * Its part of a carrier's numbers among the providers whose history for the carrier is
   * equally full. Larger for a provider whose loss would cost little, smaller for one that
   * several carriers have as their only source or whose every lookup costs a browser read.
   */
  share: number;
  /** Asked after the other providers whatever the evidence, the higher the later. */
  after?: number;
}

/**
 * The providers, largest share first. Ship24 could be lost with little harm; ParcelsApp and
 * 17TRACK are each the only source of several carriers. Ordertracker serves a few carriers
 * that ParcelsApp or 17TRACK also have, so it takes more than ParcelsApp, but it reads the
 * carrier while the lookup waits unless it has a copy of the parcel. 17TRACK, Track123 and
 * Track718 cost a browser read, Track123's the longest. Postal Ninja's histories rarely have
 * a scan whose clock a consumer can place, and UPU's feed is sparse: both are asked after
 * the others.
 */
export const UNIVERSAL_PROVIDERS: Readonly<Record<Source, UniversalProvider>> = {
  Ship24: { transport: 'http', budgetMs: 30_000, share: 4 },
  Ordertracker: { transport: 'http', slow: true, budgetMs: 30_000, share: 3 },
  ParcelsApp: { transport: 'http', budgetMs: 45_000, share: 2 },
  '17TRACK': { transport: 'browser', budgetMs: 30_000, share: 1 },
  Track123: { transport: 'browser', budgetMs: 30_000, share: 1 },
  Track718: { transport: 'browser', budgetMs: 30_000, share: 1 },
  'Postal Ninja': { transport: 'browser', budgetMs: 30_000, share: 1, after: 1 },
  UPU: { transport: 'http', budgetMs: 8_000, share: 1, after: 2 },
};
const SOURCES = Object.keys(UNIVERSAL_PROVIDERS) as Source[];

/** The providers a consumer enables to get the plan of a number no option widens. */
export const UNIVERSAL_SOURCES: Source[] = ['ParcelsApp', 'Ship24', '17TRACK', 'Track718', 'Ordertracker', 'UPU'];
/** Providers reached only through the browser service. */
export const BROWSER_SOURCES: ReadonlySet<Source> = new Set(SOURCES.filter((source) => UNIVERSAL_PROVIDERS[source].transport === 'browser'));

/** Lookup time reserved by the chain and host router, before transport allowance. */
export function universalSourceBudget(source: Source): number {
  return UNIVERSAL_PROVIDERS[source].budgetMs;
}

/** Evidence-based exception to affinity/rotation, shared by discovery and routing. */
export function priorityUniversalSource(trackingNumber?: string): Source | undefined {
  // The Express corpus has complete Ship24 histories where ParcelsApp can be empty or input-gated.
  if (trackingNumber && /^\d{10}$/.test(normalizeTrackingNumber(trackingNumber))) return 'Ship24';
  // E-series and untested formats keep ordinary discovery.
  return trackingNumber && /^[CL][A-Z]\d{9}CN$/.test(normalizeTrackingNumber(trackingNumber)) && isValidS10TrackingNumber(trackingNumber)
    ? '17TRACK' : undefined;
}

export interface UniversalPlan {
  /** The eligible providers, in the order to ask them. */
  sources: Source[];
  /** The carrier whose coverage evidence ordered them, or null without any. */
  carrier: string | null;
  /** A provider's coverage tier for that carrier; `unknown` without evidence. */
  tier(source: Source): CoverageTier;
  /** Lower is fuller history for the carrier; providers without evidence share one rank. */
  rank(source: Source): number;
}

type Tiers = Partial<Record<Source, CoverageTier>> | null;
const TIER_RANK: Record<CoverageTier, number> = { full: 0, partial: 1, unknown: 2, empty: 3, excluded: 4 };
/**
 * UPU's sparse feed ranks as a provider without evidence. Postal Ninja ranks no
 * higher than one without history: its histories rarely have a scan whose clock
 * a consumer can place, so its rows are not usable history.
 */
function tierRank(tiers: Tiers, source: Source): number {
  const rank = TIER_RANK[tiers?.[source] ?? 'unknown'];
  if (source === 'UPU') return TIER_RANK.unknown;
  return source === 'Postal Ninja' ? Math.max(rank, TIER_RANK.empty) : rank;
}

/** A stable 32-bit hash of a string: FNV-1a, then MurmurHash3's final mix. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

/**
 * A provider's draw for a number; the lowest draw is asked first. Each provider draws from
 * the number and its own name (weighted rendezvous hashing), so a number keeps its order
 * from one lookup to the next, a provider leads a part of the numbers in proportion to its
 * share, and the others keep their order when one of them is left out. Without a number,
 * the largest share leads.
 */
function draw(source: Source, trackingNumber: string | undefined): number {
  const { share } = UNIVERSAL_PROVIDERS[source];
  if (!trackingNumber) return -share;
  return -Math.log((hash(`${source}\n${normalizeTrackingNumber(trackingNumber)}`) + 0.5) / 2 ** 32) / share;
}

export interface UniversalOrder {
  /** The number looked up: it settles which of several equal providers is asked first. */
  trackingNumber?: string;
  /**
   * Nobody waits for the answer. Providers with equally full history then share the
   * numbers whatever their speed; otherwise the fast HTTP ones are asked before Ordertracker
   * and the browser ones, which answer seconds later.
   */
  background?: boolean;
}

/**
 * Orders providers by a carrier's coverage tiers: fuller history first, never traded for
 * speed or load. Providers of one tier share the numbers by their `share`, the fast ones
 * first unless the lookup runs in the background. Excluded providers are left out unless
 * nothing else would remain. Postal Ninja and then UPU stay last whatever their evidence.
 */
export function orderUniversalSources(eligible: readonly Source[], tiers: Tiers, order: UniversalOrder = {}): Source[] {
  const excluded = (source: Source) => source !== 'UPU' && tiers?.[source] === 'excluded';
  const usable = eligible.some((source) => source !== 'UPU' && !excluded(source)) ? eligible.filter((source) => !excluded(source)) : [...eligible];
  const draws = new Map(usable.map((source) => [source, draw(source, order.trackingNumber)]));
  const slow = (source: Source) => order.background ? 0
    : Number(UNIVERSAL_PROVIDERS[source].transport === 'browser' || !!UNIVERSAL_PROVIDERS[source].slow);
  const after = (source: Source) => UNIVERSAL_PROVIDERS[source].after ?? 0;
  return usable.sort((a, b) => after(a) - after(b) || tierRank(tiers, a) - tierRank(tiers, b)
    || slow(a) - slow(b) || draws.get(a)! - draws.get(b)!);
}

/** Catalog carriers other than the catalog's own `unknown`. */
const CARRIERS: ReadonlySet<string> = new Set(CARRIER_IDS.filter((carrier) => carrier !== 'unknown'));

/**
 * Providers that returned no history for any of a carrier's parcels, though asked about
 * many, and that are no longer asked about them; `all` when no provider answered. The
 * evidence is in COVERAGE.md. A consumer's own counts (`observed`) do the same for the
 * carriers it follows.
 */
const UNANSWERED: Readonly<Record<string, 'all' | readonly Source[]>> = {
  'flash-courier': 'all',
  'j-and-t-br': 'all',
  'j-and-t-de': 'all',
  gzyl: ['Ship24'],
};

export { numberIsLinkToken } from './linkToken.js';

/**
 * The providers to ask for a number, in order. The coverage evidence is that of the first
 * of `carriers` that has some: the carrier the lookup is for, whose evidence includes the
 * consumer's own counts, then the one confirmed or discovered for the number.
 *
 * Postal Ninja's browser lookups rarely find a named carrier's parcel that the other
 * aggregators missed. It is asked about one only when that carrier's evidence shows its
 * history, and about any number no carrier is named for, where it is often the only
 * provider with the parcel. Track123 is asked through a courier's own page, so only about
 * the carrier the lookup is for, when that page answered the carrier's public numbers
 * (track123/couriers.ts). Ordertracker relays each carrier through feeds whose clocks differ, so
 * it too is asked only about the lookup's carrier, when that carrier's feeds were checked
 * (ordertracker/feeds.ts). Track718 found none of the parcels it was asked about, and each
 * try costs a browser read: the plan leaves it out, and only an explicit request asks it.
 */
export function universalPlan(options: UniversalOrder & {
  carriers?: ReadonlyArray<string | null | undefined>;
  enablePostalNinja?: boolean;
  /** Opt-in public-page lookups, only about a lookup's carrier that Track123 has a verified page for. */
  enableTrack123?: boolean;
  /** The consumer's own counts for the lookup's carrier, the first of `carriers`: they replace its references' tiers. */
  observed?: Partial<Record<Source, ObservedCoverage>>;
} = {}): UniversalPlan {
  const { trackingNumber } = options;
  const carriers = options.carriers ?? [];
  const evidence = (index: number) => coverageTiers(carriers[index], index === 0 && carriers[0] ? options.observed : undefined);
  const evident = carriers.findIndex((_, index) => evidence(index));
  const carrier = carriers[evident] ?? null;
  const tiers = evident < 0 ? null : evidence(evident);
  const plan = (sources: Source[]): UniversalPlan => ({
    sources, carrier, tier: (source) => tiers?.[source] ?? 'unknown', rank: (source) => tierRank(tiers, source),
  });
  const first = carriers.find((candidate) => candidate && CARRIERS.has(candidate));
  const unanswered = first && Object.hasOwn(UNANSWERED, first) ? UNANSWERED[first]! : [];
  if (carriers.some(numberIsLinkToken) || (!first && linkTokenKept(null, trackingNumber)) || unanswered === 'all') return plan([]);
  const asked = (source: Source): boolean => {
    if (unanswered.includes(source)) return false;
    if (source === 'Track718') return false;
    if (source === 'Track123') return !!options.enableTrack123 && !!track123CourierCode(carriers[0]);
    if (source === 'Ordertracker') return !!ordertrackerFeeds(carriers[0]);
    if (source === 'Postal Ninja') return !!options.enablePostalNinja && (!first || ['full', 'partial'].includes(tiers?.[source] ?? 'unknown'));
    return source !== 'UPU' || trackingNumber === undefined || isValidS10TrackingNumber(trackingNumber);
  };
  const ordered = orderUniversalSources(SOURCES.filter(asked), tiers, options);
  // The number's priority provider goes first, unless the carrier's evidence left it out.
  const priority = ordered.find((source) => source === priorityUniversalSource(trackingNumber));
  return plan(priority ? [priority, ...ordered.filter((source) => source !== priority)] : ordered);
}

/** The order for a number, without a carrier's evidence. */
export function universalSources(enablePostalNinja = false, trackingNumber?: string): Source[] {
  return universalPlan({ trackingNumber, enablePostalNinja }).sources;
}
