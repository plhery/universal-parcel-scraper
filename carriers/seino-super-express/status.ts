import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: Readonly<Record<string, Stage>> = {
  '受付': 'accepted',
  'カゴ積込': 'in_transit',
  '運行': 'in_transit',
  '荷物到着': 'in_transit',
  'センター通過': 'in_transit',
  '指定場所置き': 'delivered',
};

export function seinoSuperExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS[normalizeStatusWording(wording)];
}

export const statusMap: CarrierStatusMap = { stage: seinoSuperExpressStage, gaps: [] };
