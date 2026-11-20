export function scanStage(description: string): 'in_transit' | undefined {
  return description === 'Departure' || description === 'Arrival' ? 'in_transit' : undefined;
}
