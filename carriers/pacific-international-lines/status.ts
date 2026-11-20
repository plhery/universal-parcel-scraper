const transit = new Set(['vessel loading', 'vessel discharge', 'truck gate out from i/b terminal']);

export function scanStage(description: string): 'accepted' | 'in_transit' | undefined {
  const wording = description.toLowerCase();
  if (wording === 'truck gate in to o/b terminal') return 'accepted';
  return transit.has(wording) ? 'in_transit' : undefined;
}
