import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import type { Stage } from '../../generated/catalog.js';

const CODES: Record<string, ClassifiedStatus> = {
  '10601': { status: 'pending', stage: 'registered' },
  '10100': { status: 'in_transit', stage: 'accepted' },
  '20700': { status: 'in_transit', stage: 'in_transit' },
  '20800': { status: 'in_transit', stage: 'in_transit' },
  '21600': { status: 'in_transit', stage: 'in_transit' },
  '21700': { status: 'in_transit', stage: 'ready_for_pickup' },
  '2201': { status: 'in_transit', stage: 'in_transit' },
  '24300': { status: 'in_transit', stage: 'customs' },
  '27900': { status: 'in_transit', stage: 'in_transit' },
  '29200': { status: 'in_transit', stage: 'in_transit' },
  '29500': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  '31200': { status: 'exception', stage: 'exception' },
  '4006': { status: 'in_transit', stage: 'in_transit' },
  '4014': { status: 'in_transit', stage: 'in_transit' },
  '4021': { status: 'in_transit', stage: 'in_transit' },
  '4024': { status: 'in_transit', stage: 'in_transit' },
  '4074': { status: 'in_transit', stage: 'in_transit' },
  '41000': { status: 'delivered', stage: 'delivered' },
  '48000': { status: 'delivered', stage: 'delivered' },
  '67300': { status: 'in_transit', stage: 'in_transit' },
  '70800': { status: 'in_transit', stage: 'in_transit' },
  '82700': { status: 'in_transit', stage: 'customs' },
  '82800': { status: 'in_transit', stage: 'in_transit' },
  '87500': { status: 'in_transit', stage: 'customs' },
  '89000': { status: 'in_transit', stage: 'customs' },
  '89100': { status: 'in_transit', stage: 'in_transit' },
  '97700': { status: 'in_transit', stage: 'in_transit' },
  // UPU's events on an item from abroad, as Ukrposhta copies them: posted (EMA), at the origin's
  // outward office of exchange and leaving it (EMB, EMC), at Ukraine's inward office (EMD),
  // presented to customs and released (EDB, EDC), and leaving the inward office (EMF).
  '17100': { status: 'in_transit', stage: 'accepted' },
  '27200': { status: 'in_transit', stage: 'in_transit' },
  '77600': { status: 'in_transit', stage: 'in_transit' },
  '60700': { status: 'in_transit', stage: 'in_transit' },
  '80700': { status: 'in_transit', stage: 'customs' },
  '80800': { status: 'in_transit', stage: 'in_transit' },
  '90800': { status: 'in_transit', stage: 'in_transit' },
};

export function ukrposhtaStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

// Ukrposhta's own Ukrainian wording, as universal providers relay it without the code, staged as
// the code the tracker gives the same scan: accepted (10100), at and leaving a logistics centre
// or a branch (20700, 20800), at the international terminal (21600), prepared for customs (82700)
// and released from it (82800), and processed there for the destination country (70800). On an
// item from abroad, its copy of the origin post's posting, beside UPU's "Posting/Collection" at
// the same minute, is the acceptance (17100), and its arrival at a sorting depot after a logistics
// centre is a leg in transit.
// Compared without case or marks, since universal rules strip them ("й" and "ї" lose theirs).
const wordingKey = (wording: string) => wording.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/\s+/gu, ' ').replace(/[.!]$/u, '').toLowerCase();
const WORDINGS = new Map<string, Stage>(([
  ['прийнято', 'accepted'],
  ['відправлення прийняте', 'accepted'],
  ['прибуло до логістичного центру', 'in_transit'],
  ['виїхало з логістичного центру', 'in_transit'],
  ['виїхало з відділення', 'in_transit'],
  ['прибуло до сортувального депо', 'in_transit'],
  ['прибуло до міжнародного терміналу', 'in_transit'],
  ['підготовлено для проведення митного контролю', 'customs'],
  ['випущено з митного контролю для подальшої доставки', 'in_transit'],
  ['оброблено на міжнародному терміналі та прямує до країни призначення', 'in_transit'],
] as const).map(([wording, stage]) => [wordingKey(wording), stage]));

/** The stage of one of Ukrposhta's scans in its Ukrainian wording, or undefined for other wording. */
export function ukrposhtaWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(wordingKey(wording));
}

// "Returned to Sender" is the decision to start the journey back. The
// separate "Return: Delivered to Sender" scan confirms its completion.
export function ukrposhtaReturnCue(label: string): boolean {
  return /^Return: /i.test(label) || /^Returned to Sender(?:\s|\()/i.test(label) || /^Повернення[.:]/i.test(label);
}

/**
 * What the map says about one scan: its code, as the parser reads it, and a delivery whose own
 * wording starts a return, such as "Return: Delivered to Sender", as returned. The stored scan
 * keeps neither the reason code that makes a scan an exception (65 and 66) nor the earlier scan
 * that started a return leg, so a delivery in that leg worded as a delivery reads as delivered.
 * A code the table does not know stays open for the app's review; both sources give every scan a
 * code, and a scan without one is read by its Ukrainian wording.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const stage = code === null ? ukrposhtaWordingStage(wording) : ukrposhtaStatus(code)?.stage;
    return stage === 'delivered' && ukrposhtaReturnCue(wording) ? 'returned' : stage;
  },
  gaps: [],
};
