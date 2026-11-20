import type { Stage } from '../../core/status/index.js';

type Movement = { description: string; stage: Stage };

export const movements: ReadonlyMap<string, Movement> = new Map([
  ['SentToShipper', { description: 'Sent to shipper', stage: 'pending' }],
  ['ReceivedFromShipper', { description: 'Received from shipper', stage: 'accepted' }],
  ['LoadFull', { description: 'Loaded on vessel', stage: 'in_transit' }],
  ['DischargeTranshipmentFull', { description: 'Discharged full', stage: 'in_transit' }],
  ['LoadTranshipmentFull', { description: 'Loaded on vessel', stage: 'in_transit' }],
  ['DischargeFull', { description: 'Discharged full', stage: 'in_transit' }],
]);
