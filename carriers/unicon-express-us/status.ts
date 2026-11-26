import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * The page's rows carry wording without codes: UNICON's own, in Chinese, then the rows of
 * the courier that delivers in China, without their city and the courier's name and phone.
 * The map is the wording recorded in `statuses.json`, then the patterns below, for rows that
 * name a courier, a number, a warehouse or a depot.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // UNICON weighs the parcel in at one of its US warehouses, which the row names.
  [/^仓库已称重入库 ?\S{0,20}$/u, 'accepted'],
  // UNICON hands the cleared parcel to a courier in China, named with its number.
  [/^包裹派送中[，,] ?已转 ?\p{Script=Han}{2,10} ?(?:快递)?[，,] ?快递单号为 ?[a-z0-9]{6,40}$/u, 'in_transit'],
  // SF Express's rows: its pickup from UNICON, its depots and its round.
  [/^顺丰速运 ?已收取快件(?:[，,].*)?$/, 'in_transit'],
  [/^快件到达 ?【[^】]{1,40}】$/, 'in_transit'],
  [/^快件在 ?【[^】]{1,40}】 ?完成分拣[，,] ?准备发往 ?【[^】]{1,40}】(?:[，,] ?根据规划班次预计发出时间 ?【[^】]{1,20}】)?$/, 'in_transit'],
  [/^快件离开 ?【[^】]{1,40}】[，,] ?已在发往 ?【[^】]{1,40}】 ?的路上$/, 'in_transit'],
  [/^快件正在派送途中/, 'out_for_delivery'],
  [/^快件派送不成功/, 'failed_attempt'],
  [/^您的快件已签收/, 'delivered'],
];

/** UNICON's note that it holds the recipient's identity card: it keeps the stage of the row before. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

/** The stage UNICON's map gives a row's wording. */
export function uniconMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. A recorded gap has none. */
export function uniconStage(wording: string): ClassifiedWording | null {
  if (GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const mapped = uniconMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : uniconMappedStage(wording)),
  gaps: GAPS,
};
