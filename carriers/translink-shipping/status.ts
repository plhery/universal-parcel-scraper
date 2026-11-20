const transit = new Set([
  'unloaded from vessel',
  'carrier and customs released',
  'customs release',
  'carrier release',
  'available for delivery',
  'vessel arrival',
  'vessel departure',
  'full container loaded on board',
  'in gate',
  'unloaded from rail',
  'arrived at facility',
  'rail arrival at destination intermodal ramp',
  'intermodal departure from last port of discharge',
  'arrival at intermodal hub by rail',
  'loaded on rail',
  'rail departure from origin intermodal ramp',
  'transhipment vessel departure',
  'loaded at port of transhipment',
  'discharged at port of transhipment',
  'transhipment vessel arrival',
  'out gate to consignee',
]);

export function scanStage(description: string): 'in_transit' | 'out_for_delivery' | undefined {
  if (description === 'Picked up at Final Destination for Delivery') return 'out_for_delivery';
  return transit.has(description.toLowerCase()) ? 'in_transit' : undefined;
}
