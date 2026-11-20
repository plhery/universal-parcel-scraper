import type { Stage } from '../../core/status/index.js';

const codes = new Map<string, { label: string; stage?: Stage; showsStation?: true }>([
  ['BKD', { label: 'Booking confirmed', stage: 'registered' }],
  ['RCS', { label: 'Shipment accepted', stage: 'accepted' }],
  ['MAN', { label: 'Manifested in', showsStation: true }],
  ['DEP', { label: 'Departed from', stage: 'in_transit', showsStation: true }],
]);

export function scanMeaning(code: string) {
  return codes.get(code);
}
