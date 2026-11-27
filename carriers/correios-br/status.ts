import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Subtypes distinguish delivery from address problems and cancelled dispatches.
// BDE, BDI and BDR are the same delivery outcomes recorded by different units.
const codes: Record<string, ClassifiedStatus> = {
  'BDE/01': { status: 'delivered', stage: 'delivered' },
  'BDI/01': { status: 'delivered', stage: 'delivered' },
  'BDE/10': { status: 'exception', stage: 'failed_attempt' },
  'BDE/20': { status: 'exception', stage: 'failed_attempt' },
  // The postman found nobody to take the item on the delivery run ("carteiro não atendido").
  'BDE/02': { status: 'exception', stage: 'failed_attempt' },
  'BDE/25': { status: 'exception', stage: 'failed_attempt' },
  // The postman found no such address on the delivery run, or one too incomplete to find (BDR/98).
  'BDE/99': { status: 'exception', stage: 'failed_attempt' },
  'BDR/98': { status: 'exception', stage: 'failed_attempt' },
  // Nobody at the address knew the recipient on the delivery run.
  'BDE/06': { status: 'exception', stage: 'failed_attempt' },
  'BDE/23': { status: 'exception', stage: 'returned' },
  'BDE/34': { status: 'exception', stage: 'exception' },
  'BDE/47': { status: 'exception', stage: 'exception' },
  'BDI/40': { status: 'exception', stage: 'exception' },
  'BDR/83': { status: 'exception', stage: 'exception' },
  'OEC/01': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // Out for delivery back to the sender: the parcel is on its way back.
  'OEC/09': { status: 'exception', stage: 'returned' },
  // Waiting for collection at the address the scan gives, or in a post office box.
  'LDI/01': { status: 'in_transit', stage: 'ready_for_pickup' },
  'LDI/02': { status: 'in_transit', stage: 'ready_for_pickup' },
  'LDI/03': { status: 'in_transit', stage: 'ready_for_pickup' },
  'FC/82': { status: 'pending', stage: 'registered' },
  // A missorted item Correios has caught and will forward again.
  'FC/03': { status: 'in_transit', stage: 'in_transit' },
  // A unit found the address wrong before any delivery run: an address problem, not an attempt.
  'FC/04': { status: 'exception', stage: 'exception' },
  // Content that is restricted or cannot fly: the item goes on by another route, with its route correction (FC/03).
  'FC/52': { status: 'in_transit', stage: 'in_transit' },
  // Sent on to a Correios unit to be collected there, as the recipient asked: collection follows (LDI).
  'FC/63': { status: 'in_transit', stage: 'in_transit' },
  'DO/01': { status: 'in_transit', stage: 'in_transit' },
  'RO/01': { status: 'in_transit', stage: 'in_transit' },
  'PAR/10': { status: 'in_transit', stage: 'in_transit' },
  // The sending post's office of exchange, before the flight to Brazil.
  'PAR/18': { status: 'in_transit', stage: 'in_transit' },
  // An item from abroad arriving in Brazil, after the sending post has accepted and dispatched it.
  'PAR/16': { status: 'in_transit', stage: 'in_transit' },
  'PO/01': { status: 'in_transit', stage: 'accepted' },
  'PO/09': { status: 'in_transit', stage: 'accepted' },
  'PAR/07': { status: 'in_transit', stage: 'in_transit' },
  'PAR/21': { status: 'in_transit', stage: 'customs' },
  // Customs in Brazil finished its inspection, and the item goes on to delivery.
  'PAR/19': { status: 'in_transit', stage: 'in_transit' },
  // The import waits for the recipient's tax number before customs can clear it.
  'FC/16': { status: 'in_transit', stage: 'customs' },
  // The import waits for customs to settle the product's classification code.
  'FC/40': { status: 'in_transit', stage: 'customs' },
  // The recipient answered customs (its tax number), and the answer is under review.
  'PAR/12': { status: 'in_transit', stage: 'customs' },
  // Customs authorized the import, and taxes or the despacho postal fee are due: it is not released until they are paid.
  'PAR/17': { status: 'in_transit', stage: 'customs' },
  // The recipient paid those taxes or that fee: customs releases the item for delivery.
  'PAR/31': { status: 'in_transit', stage: 'in_transit' },
  'PAR/24': { status: 'exception', stage: 'returned' },
  // An item posted for abroad sent to Brazil's export customs inspection; a transfer follows its release.
  'PAR/04': { status: 'in_transit', stage: 'customs' },
  // An item received at a unit along its way, which the reply may leave without an address.
  'PAR/15': { status: 'in_transit', stage: 'in_transit' },
};

// Wordings Correios documents without a code, as normalized wording.
const wordings: Record<string, ClassifiedStatus> = {
  // Correios's import guide: taxes or its despacho postal fee are due, and the import is not released until they are paid.
  'aguardando pagamento': { status: 'in_transit', stage: 'customs' },
};

export function classifyCorreiosStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/** A wording Correios documents without a code. */
export function classifyCorreiosWording(wording: string): ClassifiedStatus | undefined {
  const key = normalizeStatusWording(wording);
  return Object.hasOwn(wordings, key) ? wordings[key] : undefined;
}

/** A scan by its code, else, where the code is not recorded, by a wording documented without one. */
export function classifyCorreiosScan(code: string, wording: string): ClassifiedStatus | undefined {
  return classifyCorreiosStatus(code) ?? classifyCorreiosWording(wording);
}

/** The stage of each recorded wording through its code, left out where two codes word it alike with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const entry of statuses.entries) {
  const key = normalizeStatusWording(entry.wording);
  const stage = (entry.code ? classifyCorreiosStatus(entry.code) : classifyCorreiosWording(entry.wording))?.stage;
  STAGE_BY_WORDING.set(key, STAGE_BY_WORDING.has(key) && STAGE_BY_WORDING.get(key) !== stage ? undefined : stage);
}

// Correios's code and subtype, as the parser stores them (`BDE/01`).
const CORREIOS_CODE = /^[A-Z]{2,4}\/\d{2}$/;

/**
 * What the map says about one scan: its code, or, for a code not recorded, a wording documented
 * without one; for a universal provider's copy without Correios's code or under the provider's
 * own, the wording Correios gives a recorded code or documents without one.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && CORREIOS_CODE.test(code) ? classifyCorreiosScan(code, wording)?.stage : STAGE_BY_WORDING.get(wording)),
  gaps: [{
    code: 'EST/11',
    note: 'Correios withdrawing the scan before it ("favor desconsiderar a informação anterior"), a second after a cancelled delivery run: no step of its own, so it keeps the stage of the scan before it until the next scan.',
  }],
};
