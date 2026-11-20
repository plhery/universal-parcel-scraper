export function scanStage(description: string): 'in_transit' | undefined {
  return description.toLowerCase() === 'in transit to destination' ? 'in_transit' : undefined;
}
