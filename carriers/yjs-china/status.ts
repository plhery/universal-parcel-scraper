import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The page's rows carry wording without codes, naming the branch or station they were scanned at.
 * The map is the wording recorded in `statuses.json`, then the patterns below for the same rows at
 * any branch or station.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage] as const));

const PLACE = '【[^】]{1,40}】';
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // A branch's courier has it on the round.
  [new RegExp(`^${PLACE} ?派件中$`, 'u'), 'out_for_delivery'],
  // Left at a parcel station or locker for the recipient to collect.
  [/^快件已(?:暂存至|存放至|存放在|放入)[^，,。；;]{1,60}(?:驿站|快递柜|快递超市|代收点|自提点)$/u, 'ready_for_pickup'],
  // Signed for at a branch, with the page's closing words or without them.
  [new RegExp(`^(?:${PLACE}|[^\\s【】，,。]{1,40})? ?已签收(?:[。，,] ?快件已送达)?$`, 'u'), 'delivered'],
];

/** The stage the firm's map gives a row's wording. */
export function yjsChinaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function yjsChinaStage(wording: string): ClassifiedWording | null {
  const mapped = yjsChinaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : yjsChinaMappedStage(wording)),
  gaps: [],
};
