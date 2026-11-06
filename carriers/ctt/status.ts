/**
 * CTT Portugal status vocabulary.
 *
 * `StateId` is the stable integer key of an event; the Portuguese `State` text
 * next to it is display prose and is never mapped. The vocabulary is explicitly
 * still being observed, so an unmapped id yields no stage at all: the sync then
 * classifies the raw wording and records where the stage came from, rather than
 * this map inventing movement.
 *
 * Provenance: derived from the prior-art client
 * https://github.com/ha-parcel-integrations/ha-ctt (MIT) and confirmed live on
 * 2026-09-10 against a delivered parcel whose whole history mapped. State 10
 * is customs: its scans on mail from abroad read "O envio foi selecionado para
 * apresentação à Alfândega" and "O envio está em desalfandegamento".
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const EVENT_STATUS: Record<number, ClassifiedStatus> = {
  1: { status: 'pending', stage: 'registered' },
  2: { status: 'in_transit', stage: 'accepted' },
  5: { status: 'exception', stage: 'returned' },
  7: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  8: { status: 'in_transit', stage: 'in_transit' },
  10: { status: 'in_transit', stage: 'customs' },
  11: { status: 'in_transit', stage: 'in_transit' },
  12: { status: 'delivered', stage: 'delivered' },
  13: { status: 'exception', stage: 'failed_attempt' },
  14: { status: 'out_for_delivery', stage: 'ready_for_pickup' },
};

/** The stage and status for a CTT `StateId`, or undefined when the id is not mapped. */
export function classifyCttStatus(stateId: unknown): ClassifiedStatus | undefined {
  return typeof stateId === 'number' && Number.isSafeInteger(stateId) ? EVENT_STATUS[stateId] : undefined;
}

/**
 * What the map says about one scan: its `StateId`, as the adapter writes it.
 * Every scan carries one, so wording alone gets nothing; an id the map does not
 * know stays open for review. State 3 ("Cancelado") is left out: its import
 * cancellation (UPU EDX) voids an arrival scan CTT recorded a second earlier at
 * a second office, so it moves nothing.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => code !== null && /^[1-9]\d{0,3}$/.test(code) ? EVENT_STATUS[Number(code)]?.stage : undefined,
  gaps: [{
    code: '3',
    wording: normalizeStatusWording('Importação cancelada.'),
    note: 'CTT voiding the arrival scan it recorded a second earlier at another office: it moves nothing, so it keeps the stage of the scan before it.',
  }],
};
