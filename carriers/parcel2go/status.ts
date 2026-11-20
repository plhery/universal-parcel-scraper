import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const codes: ReadonlyMap<string, Stage> = new Map([
  ['97664C9B', 'delivered'],
  ['F71F5093', 'in_transit'],
  ['9E1D3F28', 'in_transit'],
  ['58D03FEA', 'in_transit'],
  ['EDBE6B15', 'in_transit'],
  ['57FB2B4A', 'in_transit'],
  ['FA1F1BD7', 'in_transit'],
  ['A9B636A0', 'in_transit'],
  ['98DDAC48', 'in_transit'],
  ['14C2EE78', 'in_transit'],
]);

const wordings: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording('Item presented at the Customs'), 'customs'],
  [normalizeStatusWording('Customs'), 'customs'],
]);

export const statusMap: CarrierStatusMap = {
  stage(code, wording) {
    return wordings.get(normalizeStatusWording(wording)) ?? (code ? codes.get(code) : undefined);
  },
  wholeWording: true,
  gaps: [],
};
