const transit = new Set(['LOADED ONTO VESSEL', 'INBOUND DELIVERY']);

export function scanStage(description: string): 'in_transit' | undefined {
  return transit.has(description) ? 'in_transit' : undefined;
}
