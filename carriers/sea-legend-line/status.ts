const movements = new Map<string, { description: string; stage?: 'in_transit' }>([
  ['VL', { description: 'LOADED ON BOARD', stage: 'in_transit' }],
  ['KH', { description: 'VESSEL DEPARTURE', stage: 'in_transit' }],
  ['DG', { description: 'VESSEL ARRIVAL', stage: 'in_transit' }],
  ['IC', { description: 'DISCHARGED', stage: 'in_transit' }],
  ['ID', { description: 'LADEN GATE OUT TERMINAL', stage: 'in_transit' }],
  ['MT', { description: 'EMPTY RETURN' }],
]);

export function scanMeaning(code: string) {
  return movements.get(code);
}
