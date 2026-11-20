import type { Stage } from '../../core/status/index.js';

interface Milestone {
  label: string;
  stage: Stage;
}

export const milestones: ReadonlyMap<string, Milestone> = new Map([
  ['Manifest_ABLDRLine::DateDelivered', { label: 'Delivered', stage: 'delivered' }],
  ['Manifest_ABLDRLine::OutForDelivDate', { label: 'Out for Delivery', stage: 'out_for_delivery' }],
  ['DateUnloaded', { label: 'Unloaded from the container at the destination warehouse', stage: 'in_transit' }],
  ['DateReleased', { label: 'Container released from customs', stage: 'in_transit' }],
  ['DateActDischarge', { label: 'Container discharged from vessel and awaiting customs clearance', stage: 'customs' }],
  ['DateArrived', { label: 'Arrival at destination port', stage: 'in_transit' }],
  ['DateActDepAsiaPort', { label: 'Shipping vessel departed from Asia Transhipment Port', stage: 'in_transit' }],
  ['DateArrTranship', { label: 'Arrived at Asia Transhipment Port', stage: 'in_transit' }],
  ['DateShipped', { label: 'Shipping vessel departed from port of loading', stage: 'in_transit' }],
  ['DateArvlPortOrigin', { label: 'Container arrived at port of loading', stage: 'in_transit' }],
  ['DateDepUnitWH', { label: 'Container departed from Origin Warehouse', stage: 'in_transit' }],
]);
