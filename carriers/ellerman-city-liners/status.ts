const descriptions = new Map([
  ['VESS', 'On Vessel'],
  ['DISC', 'Discharged'],
  ['OUTG', 'Out Gated'],
  ['ERET', 'Empty container returned'],
]);

export function scanDescription(code: string): string {
  return descriptions.get(code) ?? code;
}

export function scanStage(code: string): 'in_transit' | undefined {
  return code === 'VESS' || code === 'DISC' || code === 'OUTG' ? 'in_transit' : undefined;
}
