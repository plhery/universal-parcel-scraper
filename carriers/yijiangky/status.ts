import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Yijiang's rows carry Chinese wording without codes, naming its depots in 【】 and the cities it heads for. The
 * map is the wording recorded in `statuses.json`, the parcel count some rows end with ("（总件数：1件）") made an
 * ellipsis, then the patterns below for the rows that name a depot or a city, whichever it is.
 */
const COUNT = /(（总件数：)\d{1,4}(件）)/g;
const key = (wording: string): string => normalizeStatusWording(wording).replace(COUNT, '$1…$2');

const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [key(entry.wording), entry.stage as Stage] as const));

// A depot in 【】, or a city and its county written out.
const PLACE = '(?:【[^】]{1,40}】|\\p{Script=Han}{2,20})';
const DEPOT = '【[^】]{1,40}】';
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // At a depot or a town on the way.
  [new RegExp(`^快件到达${PLACE}$`, 'u'), 'in_transit'],
  // Sorted at a depot for the next one.
  [new RegExp(`^快件在${DEPOT}完成分拣[，,]准备发往${PLACE}$`, 'u'), 'in_transit'],
  // Given to the depot whose round delivers it; the courier takes it in the next row.
  [new RegExp(`^快件分配到${DEPOT}[，,]?准备派件$`, 'u'), 'in_transit'],
];

/** The stage the firm's map gives a row's wording. */
export function yijiangMappedStage(wording: string): Stage | undefined {
  const mapped = key(wording);
  return BY_WORDING.get(mapped) ?? PATTERNS.find(([pattern]) => pattern.test(mapped))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function yijiangStage(wording: string): ClassifiedWording | null {
  const mapped = yijiangMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the reply has no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : yijiangMappedStage(wording)),
  gaps: [],
};
