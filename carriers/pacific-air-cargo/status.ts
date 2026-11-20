import type { Stage } from '../../core/status/index.js';

export const stages = {
  'Shipment Received': 'accepted',
  'Flight Departed': 'in_transit',
  'Flight Arrived': 'in_transit',
  'Shipment Recovered': 'delivered',
} satisfies Record<string, Stage>;

export type Activity = keyof typeof stages;
