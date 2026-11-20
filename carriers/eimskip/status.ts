const transit = new Set(['Vessel departed', 'Vessel arrived', 'Discharged from vessel']);

export function scanStage(description: string): 'registered' | 'in_transit' | undefined {
  if (description === 'Booked') return 'registered';
  return transit.has(description) ? 'in_transit' : undefined;
}
