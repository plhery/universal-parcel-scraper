import type { ClassifiedStatus } from '../../core/status/index.js';

// Subtypes distinguish delivery from address problems and cancelled dispatches.
// BDE, BDI and BDR are the same delivery outcomes recorded by different units.
const codes: Record<string, ClassifiedStatus> = {
  'BDE/01': { status: 'delivered', stage: 'delivered' },
  'BDI/01': { status: 'delivered', stage: 'delivered' },
  'BDE/10': { status: 'exception', stage: 'failed_attempt' },
  'BDE/20': { status: 'exception', stage: 'failed_attempt' },
  'BDE/23': { status: 'exception', stage: 'returned' },
  'BDE/34': { status: 'exception', stage: 'exception' },
  'BDE/47': { status: 'exception', stage: 'exception' },
  'BDI/40': { status: 'exception', stage: 'exception' },
  'BDR/83': { status: 'exception', stage: 'exception' },
  'OEC/01': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // Out for delivery back to the sender: the parcel is on its way back.
  'OEC/09': { status: 'exception', stage: 'returned' },
  'LDI/02': { status: 'in_transit', stage: 'ready_for_pickup' },
  'FC/82': { status: 'pending', stage: 'registered' },
  // A missorted item Correios has caught and will forward again.
  'FC/03': { status: 'in_transit', stage: 'in_transit' },
  'DO/01': { status: 'in_transit', stage: 'in_transit' },
  'RO/01': { status: 'in_transit', stage: 'in_transit' },
  'PAR/10': { status: 'in_transit', stage: 'in_transit' },
  'PAR/16': { status: 'in_transit', stage: 'accepted' },
  'PO/01': { status: 'in_transit', stage: 'accepted' },
  'PO/09': { status: 'in_transit', stage: 'accepted' },
  'PAR/07': { status: 'in_transit', stage: 'in_transit' },
  'PAR/21': { status: 'in_transit', stage: 'customs' },
  'PAR/24': { status: 'exception', stage: 'returned' },
};

export function classifyCorreiosStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}
