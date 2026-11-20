const transit = new Set([
  'departed from', 'received for import', 'discharged full from vessel', 'loaded full on vessel',
]);

export function scanStage(description: string): 'accepted' | 'in_transit' | undefined {
  const wording = description.toLowerCase().replace(/\s+/g, ' ');
  if (wording === 'received for export') return 'accepted';
  if (transit.has(wording)) return 'in_transit';
  return undefined;
}
