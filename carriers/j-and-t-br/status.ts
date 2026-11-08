import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
const STAGES: Readonly<Record<string, Stage>> = {
  '10': 'accepted', '50': 'in_transit', '90': 'in_transit', '92': 'in_transit',
  '94': 'out_for_delivery', '100': 'delivered',
};
export const jAndTBrStage = (code: string): Stage | undefined => STAGES[code];
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['retirou a encomenda', 'accepted'], ['Chegada da encomenda expressa', 'in_transit'],
  ['Saída da encomenda expressa', 'in_transit'], ['enviando a encomenda', 'out_for_delivery'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));
export const statusMap: CarrierStatusMap = { stage: (code, wording) =>
  (code === null ? undefined : jAndTBrStage(code)) ?? WORDINGS.get(normalizeStatusWording(wording)), gaps: [] };
