const transit = new Set([
  'Trucking back to Depo / CY',
  'Container on Board',
  'Vessel Arrived',
  'Vessel Berthing',
  'Container Discharge from Vessel',
]);

export function scanStage(description: string): 'in_transit' | 'registered' | undefined {
  if (description === 'Booking Requested') return 'registered';
  return transit.has(description) ? 'in_transit' : undefined;
}
