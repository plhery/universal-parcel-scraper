import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDING = new Map<string, Stage>([
  ['交寄郵件', 'accepted'], ['運輸途中', 'in_transit'], ['安排投遞中', 'in_transit'],
  ['郵件投遞中', 'out_for_delivery'], ['到達出口互換局', 'in_transit'], ['已出口－資料詳如右方', 'in_transit'],
  ['郵袋接收', 'in_transit'], ['到達寄達國互換局', 'in_transit'], ['海關查驗', 'customs'], ['離開進口局', 'in_transit'],
  ['離開寄達國互換局', 'in_transit'], ['到達寄達國投遞局', 'in_transit'], ['投遞不成功', 'failed_attempt'], ['投遞成功', 'delivered'],
]);
export function chunghwaPostStage(wording: string): ClassifiedWording | null {
  const stage = WORDING.get(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}
// ParcelsApp relays a scan as the office and the status in one label, sometimes followed by the
// tracker's follow-up column left empty ("<office>, 到達出口互換局, 後續處理方式:"). A follow-up with
// words in it is not read: it can send the item somewhere else.
const RELAYED = /^([^,，]{1,60}), ([^,，]{1,60})(?:, 後續處理方式[:：])?$/u;

/** A label an aggregator relays from the tracker, staged by the map, with the office it names as its place. */
export function chunghwaPostScan(label: string): { stage: Stage; wording: string; location?: string } | undefined {
  const text = label.trim();
  const whole = WORDING.get(text);
  if (whole) return { stage: whole, wording: text };
  const [, office, status] = RELAYED.exec(text) ?? [];
  const stage = status ? WORDING.get(status.trim()) : undefined;
  return stage ? { stage, wording: status!.trim(), location: office!.trim() } : undefined;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDING.get(wording), gaps: [] };
