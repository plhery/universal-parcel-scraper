export function scanStage(description: string): 'in_transit' | undefined {
  const status = description.toUpperCase();
  return status === 'PORT OF DISCHARGING' || /^ON SHIP(?:\s*-\s*.+)?$/.test(status) ? 'in_transit' : undefined;
}
