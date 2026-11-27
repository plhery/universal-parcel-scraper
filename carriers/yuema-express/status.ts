import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording: string; readonly stage: string | null; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The code of the rows the courier that delivers in China wrote, which Yuema merges into its list. */
export const COURIER_CODE = 'ZT';

// Yuema's own codes, one stage each whatever the row's wording, which names a store, warehouse or courier.
const CODED: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.code !== COURIER_CODE && entry.stage ? [[entry.code, entry.stage as Stage] as const] : []));

// The courier's rows, by their wording without the courier's name and phone number.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.code === COURIER_CODE && entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

// SF Express's rows that name its depots, as UNICON Express USA's page relays them too.
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  [/^顺丰速运 ?已收取快件(?:[，,].*)?$/, 'in_transit'],
  [/^快件到达 ?【[^】]{1,40}】$/, 'in_transit'],
  [/^快件在 ?【[^】]{1,40}】 ?完成分拣[，,] ?准备发往 ?【[^】]{1,40}】(?:[，,] ?根据规划班次预计发出时间 ?【[^】]{1,20}】)?$/, 'in_transit'],
  [/^快件离开 ?【[^】]{1,40}】[，,] ?已在发往 ?【[^】]{1,40}】 ?的路上$/, 'in_transit'],
  [/^快件正在派送途中/, 'out_for_delivery'],
  [/^快件派送不成功/, 'failed_attempt'],
  [/^您的快件已签收/, 'delivered'],
];

// SF's forecast of the day the parcel reaches its city, with the day and city in 【】.
const FORECAST = /^预计 ?【[^】]{1,20}】 ?到达 ?【[^】]{1,40}】/;
const FORECAST_NOTE = "SF Express's forecast of the day the parcel reaches the destination city: it keeps the stage of the row before.";

const gapNote = (code: string | null, wording: string): string | undefined =>
  code === COURIER_CODE && FORECAST.test(wording) ? FORECAST_NOTE : undefined;

/** The stage Yuema's map gives a row: by its code, or a courier's row by its wording. */
export function yuemaMappedStage(code: string, wording: string): Stage | undefined {
  if (code !== COURIER_CODE) return CODED.get(code);
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. SF's forecast has none. */
export function yuemaStage(code: string, wording: string): ClassifiedWording | null {
  if (gapNote(code, normalizeStatusWording(wording))) return null;
  const mapped = yuemaMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its code: the page's rows always carry one. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? yuemaMappedStage(code, wording) : undefined),
  gaps: [],
  gapNote,
};
