import type { Stage } from '../../core/status/index.js';

export const actions = new Map<string, { description: string; stage: Stage }>([
  ['BKD', { description: 'Booking confirmed', stage: 'registered' }],
  ['EXE', { description: 'Booking executed', stage: 'registered' }],
  ['RCS', { description: 'Shipment accepted', stage: 'accepted' }],
  ['REPLAN', { description: 'Shipment re-planned', stage: 'registered' }],
  ['RCT', { description: 'Shipment transferred', stage: 'in_transit' }],
  ['PRE', { description: 'Pre-manifested', stage: 'in_transit' }],
  ['MAN', { description: 'Manifested', stage: 'in_transit' }],
  ['DEP', { description: 'Departed', stage: 'in_transit' }],
  ['ARR', { description: 'AWB Arrived', stage: 'in_transit' }],
  ['RCF', { description: 'Received from flight', stage: 'in_transit' }],
  ['TFD', { description: 'Shipment transferred', stage: 'in_transit' }],
  ['AWD', { description: 'Document arrived', stage: 'in_transit' }],
  ['NFD', { description: 'Ready for pick-up', stage: 'ready_for_pickup' }],
  ['DLV', { description: 'Delivered', stage: 'delivered' }],
]);
