import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bfeStage, bfeWording } from './status.js';

export const PROVIDER = 'BFE Express';
// The tracking page's search box takes six to fifty letters, digits and hyphens.
const NUMBER = /^[0-9A-Z]{6,50}$/;
// "2026-11-19 17:00:00 (GMT-03:00)": the scan's clock where it happened, and that place's offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?: \(GMT([+-](?:0\d|1[0-4]):[0-5]\d)\))?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const COUNTRY = /^[A-Z]{2}$/;
// The legs a reply lists scans under, the leg before the hand-over to the last mile first.
const LEGS = ['firstLegTrackingDetails', 'supplierTrackingDetails'] as const;
const MAX_ITEMS = 10;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
/** Stages after which BFE's estimated day no longer applies. */
const ENDED: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'ready_for_pickup']);

/** A BFE Express number, in upper case. */
export function normalizeBfeNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BFE Express numbers are six to fifty letters and digits');
  return number;
}

const invalid = (message: string) => new SchemaError(PROVIDER, message);

function text(value: unknown, field: string, maxLength: number): string {
  if (value != null && typeof value !== 'string') throw invalid(`BFE Express returned an invalid ${field}`);
  return clean(value, maxLength);
}

/** A row's place in its list: the reply numbers groups and scans from the oldest. */
function order(value: unknown): number {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value)) throw invalid('BFE Express returned an invalid scan order');
  return value as number;
}

/** A scan's clock: an instant in the offset the row gives, else the clock alone. */
function clockOf(raw: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const match = CLOCK.exec(raw);
  const parsed = match ? explicitOffsetTime(`${match[1]}T${match[2]}${match[3] ?? 'Z'}`) : null;
  if (!match || !parsed) throw invalid('BFE Express returned an invalid scan time');
  return match[3] ? { time: parsed.iso } : { local_time: `${match[1]}T${match[2]}` };
}

/** The scans of every leg, newest first. */
function eventsOf(item: Record<string, unknown>): CarrierEvent[] {
  const rows: { event: CarrierEvent; at: readonly number[] }[] = [];
  LEGS.forEach((leg, legIndex) => {
    const groups = item[leg] ?? [];
    if (!Array.isArray(groups)) throw invalid('BFE Express changed its scan groups');
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.trackingDetails)) throw invalid('BFE Express changed its scan groups');
      const groupOrder = order(group.carrierCodeViewOrder);
      for (const detail of group.trackingDetails) {
        if (!isRecord(detail)) throw invalid('BFE Express returned an invalid scan');
        const written = text(detail.description, 'scan wording', 300);
        if (!written) throw invalid('BFE Express returned a scan without wording');
        const shown = bfeWording(written);
        const stage = bfeStage(normalizeStatusWording(shown.description));
        rows.push({ at: [legIndex, groupOrder, order(detail.viewOrder)], event: { ...clockOf(text(detail.dateTimeString, 'scan time', 64)),
          ...shown, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } });
        if (rows.length > MAX_ROWS) throw invalid('BFE Express returned an oversized history');
      }
    }
  });
  // The page shows each list by its order numbers, newest first; rows numbered alike keep the reply's order.
  rows.sort((left, right) => right.at[0]! - left.at[0]! || right.at[1]! - left.at[1]! || right.at[2]! - left.at[2]!);
  return rows.map(({ event }) => event);
}

/** BFE's planned day, while the parcel is on its way and no scan is later than it. */
function plannedDay(value: unknown, stage: Stage | undefined, latest: CarrierEvent): string | null {
  const match = DAY.exec(text(value, 'planned day', 20));
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  const seen = (latest.time ?? latest.local_time)?.slice(0, 10);
  return day && !(stage && ENDED.has(stage)) && !(seen && seen > day) ? day : null;
}

/**
 * BFE Express's answer for one number: a list of shipments, each under the number it was asked by, with
 * BFE's status for it and its scans in groups, by leg and carrier. A number it does not know comes back
 * with the status NotFound and no scan; one it lists before any scan, with no scan.
 */
export function parseBfe(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBfeNumber(raw);
  if (!Array.isArray(payload) || payload.length > MAX_ITEMS || !payload.every(isRecord)) throw invalid('BFE Express returned an invalid tracking reply');
  const items = payload.filter(item => [item.orderNumber, item.trackingNumber]
    .some(value => typeof value === 'string' && normalizeTrackingNumber(value) === number));
  if (items.length !== 1) throw new IndeterminateError(PROVIDER, 'BFE Express did not answer for the number asked');
  const item = items[0]!;
  const state = text(item.orderStatus, 'shipment status', 40);
  if (!state) throw invalid('BFE Express returned a shipment without a status');
  const events = eventsOf(item);
  if (state === 'NotFound') {
    if (events.length) throw invalid('BFE Express returned scans for a number it does not find');
    throw new IndeterminateError(PROVIDER, 'BFE Express does not find the number yet', { reason: 'portal_not_found' });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'BFE Express lists the shipment without a scan', { reason: 'listed' });

  const decider = events.find(event => event.stage);
  let stage = decider?.stage as Stage | undefined;
  let lastText = (decider ?? events[0]!).description!;
  // BFE's status for the shipment says when it is delivered, whatever its last scan's wording.
  const declared = state === 'Delivered' && stage !== 'delivered';
  if (declared) {
    stage = 'delivered';
    lastText = state;
  }
  const latest = events[0]!;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered')?.time : undefined;
  const country = text(item.destinctCountry, 'destination country', 20);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(declared ? { provider_code: state } : {}),
    last_status_text: lastText,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time ?? null,
    expected_delivery: plannedDay(item.planDeliveryTimeDescription, stage, latest),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(COUNTRY.test(country) ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
