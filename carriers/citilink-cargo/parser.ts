import { parseIcmsTracking, type IcmsCarrier } from '../garuda-indonesia-cargo/parser.js';

export const citilink = { id: 'citilink-cargo', name: 'Citilink Cargo', prefix: '888' } satisfies IcmsCarrier;

export function parseTracking(data: unknown, serial: string) {
  return parseIcmsTracking(data, serial, citilink);
}
