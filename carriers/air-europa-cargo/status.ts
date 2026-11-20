import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const codes: ReadonlyMap<string, Stage> = new Map([
  ['ARR', 'in_transit'],
  ['DIS', 'exception'],
  ['FIW', 'in_transit'],
  ['FOW', 'in_transit'],
]);

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage(code, wording) {
    if (code) return codes.get(code);
    if (wording === 'delivery') return 'delivered';
    if (wording === 'ready for carriage' || /^freight on hands [a-z]{3}$/.test(wording)) return 'accepted';
    if (/^(?:departed|received) [a-z]{3}(?: gha)?$/.test(wording)) return 'in_transit';
    return undefined;
  },
  gaps: [
    { code: 'AWD', note: 'Air-waybill documents were delivered. This scan does not confirm delivery of the cargo.' },
    { code: 'AWR', note: 'The air-waybill documents were received.' },
    { code: 'NFD', note: 'The consignee or its agent was notified. This can occur at a transfer airport.' },
  ],
  gapNote(code, wording) {
    if (!code && /^(?:pre-)?manifested [a-z0-9]+$/.test(wording)) return 'Manifest preparation does not confirm departure.';
    return undefined;
  },
};
