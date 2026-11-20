import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  gaps: [],
  stage(_code, wording) {
    return wording === 'yaradıldı' ? 'registered' : undefined;
  },
};
