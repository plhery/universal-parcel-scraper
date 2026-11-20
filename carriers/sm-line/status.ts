const vesselMovements = new Set(['FLVMLO', 'FLVMDO', 'FUVMAD', 'FUVMBD', 'FUVMUD']);
const truckMovements = new Set(['Truck Gate In to I/B Terminal', 'Truck Gate Out from I/B Terminal']);

export function scanStage(code: string, description: string): 'accepted' | 'in_transit' | undefined {
  if (code === 'FOTMAD') return 'accepted';
  if (vesselMovements.has(code) || (code === 'YYYYYY' && truckMovements.has(description))) return 'in_transit';
  return undefined;
}
