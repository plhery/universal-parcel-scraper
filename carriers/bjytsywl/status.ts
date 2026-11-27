import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The page's rows carry wording without codes, naming the sorting centres in 【】. The map is
 * the wording recorded in `statuses.json`, then the patterns below for the rows that name a
 * centre, whichever it is.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage] as const));

const PLACE = '【[^】]{1,40}】';
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // Loaded at one centre for the next, by road or by air.
  [new RegExp(`^快件从 ?${PLACE} ?正在装车[，,] ?准备(?:飞往|发往|运往) ?${PLACE}$`, 'u'), 'in_transit'],
  // At a centre, on to the next one or to the round that delivers it.
  [new RegExp(`^快件已到达 ?${PLACE}[，,]? ?准备(?:发往 ?${PLACE}|派件)$`, 'u'), 'in_transit'],
];

/** The stage the firm's map gives a row's wording. */
export function bjytsywlMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function bjytsywlStage(wording: string): ClassifiedWording | null {
  const mapped = bjytsywlMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : bjytsywlMappedStage(wording)),
  gaps: [],
};
