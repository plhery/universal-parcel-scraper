import type { Stage } from '../../core/status/index.js';

export const blueDartHandoff = 'Shipment has been connected via Blue Dart';

export const stages = new Map<string, Stage>([
  ['Delivered', 'delivered'],
  [blueDartHandoff, 'in_transit'],
]);
