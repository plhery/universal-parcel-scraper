import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map(([
  ['Kabul Bekliyor', 'registered'],
  ['Kabul Edildi', 'accepted'],
  ['Yönlendirmede', 'in_transit'],
  ['Yolda', 'in_transit'],
  ['Teslimat Şubesinde', 'in_transit'],
  ['Dağıtımda', 'out_for_delivery'],
  ['Teslim Edildi', 'delivered'],
] satisfies [string, Stage][]).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? stages.get(normalizeStatusWording(wording)) : undefined,
  wholeWording: true,
  gaps: [{ wording: normalizeStatusWording('Süreci Devam Ediyor'), note: 'The carrier uses this wording for an appointment request without saying that the parcel moved.' }],
};
