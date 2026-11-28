import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { classifyWording } from '../../core/status/wording.js';

/**
 * Courier Navigator, the courier software UBX UK, World Package, Hart2Hart Express, Flight Logistics
 * and eCourier track on, writes each event with a numeric status id ("20.00"). Its tracking and
 * job pages read the ids as ranges: below 11 the job waits for its collection, 11 is the collection,
 * up to 20 the job is on its way, 19 and 20 are the delivery (the page marks those events and the
 * delivery address done), up to 30 the page still counts the job delivered, and above 30 cancelled.
 */
const COLLECTED = 11;
const DELIVERED = new Set([19, 20]);
const LAST_DELIVERED = 30;
// Between the collection and the delivery, an event's wording can say more than "on its way".
const WORDED: ReadonlySet<Stage> = new Set(['out_for_delivery', 'failed_attempt', 'customs', 'ready_for_pickup', 'exception']);

/** A status id as the reply writes it, "20.00" or 20, in its short form ("20"), or '' for none. */
export function navigatorCode(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{1,3}(?:\.\d{1,2})?$/.test(text) ? String(Number(text)) : undefined;
}

const idOf = (code: string | null): number | undefined => (code !== null && /^\d{1,3}(?:\.\d{1,2})?$/.test(code) ? Number(code) : undefined);

/** The stage of an event by its status id and wording, and what gave it. */
export function navigatorStage(code: string | null, wording: string): { stage: Stage; source: string } | undefined {
  const id = idOf(code);
  if (id === undefined) {
    if (code !== null) return undefined;
    const worded = classifyWording(wording, 'in_transit');
    return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
  }
  if (id < COLLECTED) return { stage: 'registered', source: 'carrier_map' };
  if (id === COLLECTED) return { stage: 'accepted', source: 'carrier_map' };
  if (DELIVERED.has(id)) return { stage: 'delivered', source: 'carrier_map' };
  if (id > LAST_DELIVERED) return { stage: 'exception', source: 'carrier_map' };
  if (id > 20) return undefined;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source !== 'none' && WORDED.has(worded.stage) ? { stage: worded.stage, source: worded.source } : { stage: 'in_transit', source: 'carrier_map' };
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => navigatorStage(code, wording)?.stage,
  gaps: [],
  gapNote: (code) => {
    const id = idOf(code);
    return id !== undefined && id > 20 && id <= LAST_DELIVERED
      ? "A step after the delivery, which Courier Navigator's pages still count delivered; it keeps the delivery."
      : undefined;
  },
};
