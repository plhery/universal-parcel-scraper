import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's event wording, in `normalizeStatusWording` form, without the
 * town it puts in parentheses at the end. The tracker shows no codes. Other
 * wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The sender entered the order, then DPD booked a courier to collect it.
  ['заказ создан, ожидаем груз от отправителя', 'registered'],
  ['назначен курьер для приема заказа', 'registered'],
  ['принят у отправителя', 'accepted'],
  // The sending terminal, the terminals on the way and the delivering one.
  ['в сортировочном центре отправления', 'in_transit'],
  ['принят на транзитном терминале', 'in_transit'],
  ['покинул транзитный терминал', 'in_transit'],
  ['прибыл в сортировочный центр доставки', 'in_transit'],
  ['доставка получателю', 'out_for_delivery'],
  // The courier came back with the parcel because the recipient refused it.
  ['возврат с маршрута в связи с отказом получателя', 'failed_attempt'],
  // The parcel goes on under another order, which the tracker names: a return or a new address.
  ['доставка по другому заказу', 'exception'],
  ['доставлен', 'delivered'],
]);

/** The stage the tracker's own wording gives an event. */
export function dpdRuMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An event's stage: the tracker's wording, else the shared rules, else nothing. */
export function dpdRuStage(wording: string): ClassifiedWording | null {
  const mapped = dpdRuMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : dpdRuMappedStage(wording)),
  gaps: [],
};
