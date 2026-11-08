import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const EXACT: ReadonlyMap<string, Stage> = new Map([
  ['Выдан', 'delivered'], ['Выдано', 'delivered'],
  ['Прибыло и помещено на склад', 'in_transit'],
  ['Погружено в транспортное средство', 'in_transit'],
  ['Оформление документов (ТТН)', 'registered'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));

export function zheldorStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return EXACT.get(text) ?? (/^(?:убыло в г\.|прибыло на транзитную станцию в г\.)\s*[^<>]{1,150}$/.test(text)
    || /^ожидается выгрузка в пункте назначения "[^"<>]{1,150}"$/.test(text) ? 'in_transit' : undefined);
}

const gaps = [
  { code: '31', wording: normalizeStatusWording('Недозвон Клиенту'), note: 'A telephone contact attempt keeps the preceding shipment stage; it does not establish a delivery attempt.' },
  { code: '52', wording: normalizeStatusWording('Отправлена СМС Получателю об отправке'), note: 'A message about dispatch keeps the preceding shipment stage; it is not a movement or customs scan.' },
] as const;

export const zheldorGap = (code: string, wording: string): boolean => gaps.some(gap => gap.code === code && gap.wording === normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => zheldorStage(wording), gaps };
