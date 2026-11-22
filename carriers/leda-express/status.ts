import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * The page's rows carry wording without codes, without the place the parser moves to the
 * location: Leda's own, then those of SF Express, which delivers in China. The map is the
 * wording recorded in `statuses.json`, then the patterns below, for rows that name a depot, a
 * number, a courier or a distance.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // Customs released the parcel, which waits for the courier named with its waybill.
  [/^海关已放行。 ?待交付当地承运方[（(][^：:（）()]{1,20}[：:] ?[a-z0-9]{4,40}[）)]。?$/, 'in_transit'],
  // SF Express's rows, as Leda's page copies them: its pickup from Leda, its depots and its trucks.
  [/^顺丰速运 ?已收取快件(?:[，,].*)?$/, 'in_transit'],
  [/^快件到达 ?【[^】]{1,80}】$/, 'in_transit'],
  [/^快件离开 ?【[^】]{1,60}】[，,] ?已在发往 ?【[^】]{1,60}】 ?的路上$/, 'in_transit'],
  [/^快件在 ?【[^】]{1,60}】 ?完成分拣[，,] ?准备发往 ?【[^】]{1,60}】$/, 'in_transit'],
  [/^快件开始长途运输[，,] ?两站距离 ?\d{1,5} ?km$/, 'in_transit'],
  [/^车辆正在长途运输中[，,] ?车辆临近 ?【[^】]{1,20}】[，,].{0,40}请您放心$/, 'in_transit'],
  // A courier, named with their phone, has the parcel on a delivery round.
  [/^快件交给 ?【[^】]{1,60}】[，,] ?正在派送途中/, 'out_for_delivery'],
  // Delivered to the recipient in person; the courier is named with their phone.
  [/^您的快件已派送至本人[，,。]/, 'delivered'],
];

/** The stage Leda's map gives a row's wording. */
export function ledaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function ledaStage(wording: string): ClassifiedWording | null {
  const mapped = ledaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : ledaMappedStage(wording)),
  gaps: [],
};
