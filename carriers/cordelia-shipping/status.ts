export const containerMovements = [
  { field: 'dhfDate', code: 'DHF', description: 'Discharged Laden', stage: 'in_transit' },
  { field: 'stcDate', code: 'STC', description: 'Sent to Consignee', stage: 'in_transit' },
  { field: 'rvcDate', code: 'RVC', description: 'Empty container received from consignee', stage: undefined },
] as const;

export function scanMeaning(code: string) {
  return containerMovements.find(movement => movement.code === code);
}
