const transit = new Set([
  'TAOMDF', 'VLLMOF', 'VDLMOF', 'VAUMDF', 'VBUMDF', 'VUUMDF', 'TDIMOF',
]);

export function scanStage(code: string): 'in_transit' | undefined {
  return transit.has(code) ? 'in_transit' : undefined;
}
