const transit = new Set([
  'MF_POL_ARRIVAL', 'MF_POL_DEPARTURE', 'MF_POD_ARRIVAL', 'MF_POD_DISCHARGE',
  'MF_PLD_ARRIVAL', 'DS_RAIL_POD_DEPARTURE',
]);

export function scanStage(code: string): 'accepted' | 'in_transit' | undefined {
  if (code === 'TM_TK_FCTN_IN_PORT') return 'accepted';
  return transit.has(code) ? 'in_transit' : undefined;
}
