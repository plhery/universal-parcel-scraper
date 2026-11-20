const transit = new Map([
  ['AE', 'CONTAINER LOAD ON VESSEL'],
  ['IL', 'IN GATE'],
  ['OA', 'OUT GATE'],
  ['UV', 'CONTAINER UNLOAD FROM VESSEL'],
  ['VA', 'VESSEL/FLIGHT ARRIVAL (ATA)'],
  ['VD', 'VESSEL/FLIGHT DEPARTURE (ATD)'],
]);

export function scanStage(code: string, description: string): 'in_transit' | undefined {
  return transit.get(code) === description ? 'in_transit' : undefined;
}
