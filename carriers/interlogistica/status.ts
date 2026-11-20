import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The adapter uses this map when it reads its own history.
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const text = normalizeStatusWording(wording);
    if (/^върната на изпращача(?:$|\s*-)/.test(text)) return 'returned';
    if (text === 'предадена на куриер за доставка') return 'out_for_delivery';
    if (text === 'постъпила в офис') return 'in_transit';
    return undefined;
  },
  gaps: [{ wording: 'невъведен', note: 'An operation the carrier labels as not entered. The scan describes no movement.' }],
};
