import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracking page's scan wordings, and the statuses its "Что значат статусы доставки" section
// explains. A parcel left uncollected is cancelled, then goes back through the point it was
// dropped at, where it waits for the sender.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Создан', 'registered'],
  // "The sender created the order, but the courier has not collected it yet."
  ['Заказ оформлен', 'registered'],
  ['Принят пунктом приёма', 'accepted'],
  // "The courier collected the order from the sender."
  ['Передана курьеру', 'accepted'],
  ['Едет в сортировочный центр', 'in_transit'],
  ['Приехал в сортировочный центр', 'in_transit'],
  ['Отгружен из сортировочного центра', 'in_transit'],
  // The pickup point took the parcel in; it says it waits for the recipient a minute later.
  ['Принят пунктом выдачи', 'in_transit'],
  ['В пути', 'in_transit'],
  ['Ждёт вручения в пункте выдачи', 'ready_for_pickup'],
  ['В пункте выдачи', 'ready_for_pickup'],
  ['Доставлено', 'delivered'],
  // The parcel's storage ran out: the order is cancelled and goes back.
  ['Отменен', 'exception'],
  ['Возвращается в пункт выдачи', 'returned'],
  ['Возвращается отправителю', 'returned'],
  ['Возврат принят пунктом приема', 'returned'],
  // Back at the point it was dropped at, waiting for the sender.
  ['Ждёт вручения в пункте приема', 'returned'],
  ['Заказ утилизирован', 'exception'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

const GAPS = [
  { wording: 'изменён срок хранения в пункте выдачи', note: 'The pickup point keeps the parcel longer; it stays where it was.' },
  { wording: 'изменена дата возврата', note: 'The return is put off to another day; the parcel keeps its stage.' },
  { wording: 'задерживается', note: 'The page explains it as a delivery taking longer than planned, with the courier trying again; the parcel keeps its stage.' },
] as const;

/** The stage of a scan's wording, or undefined for one the page does not explain or does not list. */
export function yandexDeliveryStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => yandexDeliveryStage(wording),
  wholeWording: true,
  gaps: GAPS,
};

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = yandexDeliveryStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  // A wording the map leaves without a stage on purpose keeps none.
  if (statusGapNote(statusMap, null, normalizeStatusWording(wording)) !== undefined) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
