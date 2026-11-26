import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;
const key = (code: string, wording: string) => `${code}\n${normalizeStatusWording(wording)}`;

/** Each step's name with the wording seen under it, as `statuses.json` records them. */
const BY_ROW: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));

/**
 * The tracker's steps that mean one stage whatever their wording. A step left out takes its
 * stage from the wording recorded under it: 包裹清关 names clearance whether it starts or ends,
 * and 转运中(尾程单号轨迹内容), "in transit (the last-mile number's rows)", holds every row it
 * copies from the partner that delivers, the round and the delivery included.
 */
const BY_STEP: ReadonlyMap<string, Stage> = new Map([
  ['包裹预报', 'registered'],
  ['揽件', 'accepted'],
  ['中转仓库处理', 'in_transit'],
  ['中转仓库出库', 'in_transit'],
  ['空运代理交货', 'in_transit'],
  ['空运离港', 'in_transit'],
  ['开始清关', 'customs'],
  ['空运到港', 'in_transit'],
  ['清关交接交出', 'in_transit'],
  ['尾程到达', 'in_transit'],
  ['妥投', 'delivered'],
] as const);

/** The stage Z1's map gives a row by its step's name and its wording. */
export function z1MappedStage(code: string | null, wording: string): Stage | undefined {
  return code ? BY_ROW.get(key(code, wording)) ?? BY_STEP.get(code) : undefined;
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function z1Stage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = z1MappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => z1MappedStage(code, wording),
  gaps: [],
};
