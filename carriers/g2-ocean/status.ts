export const portMilestones = [
  { field: 'arrivalDate', wording: 'Arrived' },
  { field: 'berthedDate', wording: 'Berthed' },
  { field: 'departureDate', wording: 'Departed' },
] as const;

export function scanStage(portType: 'L' | 'D', field: string): 'in_transit' | undefined {
  if (portType === 'D' || field === 'departureDate') return 'in_transit';
  return undefined;
}
