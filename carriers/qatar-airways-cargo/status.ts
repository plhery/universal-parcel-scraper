import type { Stage } from '../../core/status/index.js';

const codes = new Map<string, { label: string; stage: Stage }>([
  ['RCS', { label: 'Received from shipper', stage: 'accepted' }],
  ['DEP', { label: 'Departed', stage: 'in_transit' }],
  ['ARR', { label: 'Arrived', stage: 'in_transit' }],
  ['RCF', { label: 'Received from flight', stage: 'in_transit' }],
  ['NFD', { label: 'Notified consignee', stage: 'in_transit' }],
]);

export function movementMeaning(code: string) {
  return codes.get(code);
}
