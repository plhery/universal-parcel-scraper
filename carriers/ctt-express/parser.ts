import { DateTime } from 'luxon';
import { isCttExpressTrackingNumber } from '../../core/detection/cttExpress.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyCttExpressStatus } from './status.js';

export function normalizeCttExpressNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  if (!isCttExpressTrackingNumber(number)) throw new InvalidInputError('CTT Express', 'CTT Express requires a Spanish shipment or single-package tracking number');
  return number;
}

function scanClock(value: unknown): { time?: string; local_time?: string; provider_time_text?: string } {
  const raw = clean(value, 64);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(raw)) {
    const instant = explicitOffsetTime(raw);
    if (instant) return { time: instant.iso };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) {
    const wall = DateTime.fromISO(raw, { zone: 'UTC' });
    if (wall.isValid) return { local_time: wall.toISO({ includeOffset: false, suppressMilliseconds: true }) };
  }
  return raw ? { provider_time_text: raw } : {};
}

export function parseCttExpress(payload: unknown, number: string): CarrierResult {
  const requested = normalizeCttExpressNumber(number);
  if (!isRecord(payload)) throw new SchemaError('CTT Express');
  // An upstream Invalid token reply can precede successful anonymous retrieval.
  // No error signature has established a reliable parcel-negative response.
  if (payload.error != null) throw new IndeterminateError('CTT Express', 'CTT Express returned an inconclusive tracking response');
  const data = payload.data;
  if (!isRecord(data) || data.shipping_code !== requested || !isRecord(data.shipping_history)) {
    throw new SchemaError('CTT Express', 'CTT Express returned a different or incomplete shipment');
  }
  const history = data.shipping_history;
  if (!Array.isArray(history.events) || history.events.length > 500) throw new SchemaError('CTT Express');
  if (!history.events.length) throw new IndeterminateError('CTT Express', 'CTT Express returned no tracking scans');
  // The public response contains one package's history. Shipment completion
  // cannot be inferred from one delivered package of a multi-piece shipment.
  if (data.item_count !== 1) throw new IndeterminateError('CTT Express', 'CTT Express did not return a single-piece shipment');
  // Official label specification: 22 shipment digits + 3 parcel-counter digits.
  const packageCode = requested.length === 25 ? requested : `${requested}001`;
  if (history.item_code !== packageCode) throw new SchemaError('CTT Express', 'CTT Express returned a different package');
  const events: CarrierEvent[] = [];
  const rows: unknown[] = history.events;
  // Newest provider positions win equal-clock ties. Preserve duplicates until
  // their chronological leg is known so an earlier return start is not lost.
  for (const row of [...rows].reverse()) {
    // Customer service cases (a new date or address) are not scans and carry
    // the recipient's contact details.
    if (isRecord(row) && row.type === 'MANAGEMENTS' && clean(row.source, 64) === 'CASE_V1') continue;
    if (!isRecord(row) || row.type !== 'STATUS' || !['ITEM_STATUS_V2', 'ITEM_STATUS_CHANGE_V1'].includes(clean(row.source, 64))) {
      throw new SchemaError('CTT Express', 'CTT Express returned an unsupported scan source');
    }
    const code = clean(row.code, 16);
    const description = clean(row.description, 500);
    if (!/^\d{4}$/.test(code) || !description) throw new SchemaError('CTT Express', 'CTT Express returned an incomplete scan');
    const clock = scanClock(row.event_date);
    const mapped = classifyCttExpressStatus(code);
    events.push({ provider_code: code, description, ...clock, ...(mapped ? { stage: mapped.stage } : {}) });
  }
  if (!events.length) throw new IndeterminateError('CTT Express', 'CTT Express returned no tracking scans');
  // An unresolved newest scan must not yield to an older instant.
  if (events.every((event) => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  // 2500 explicitly starts delivery back to the sender. Apply that evidence
  // chronologically, using the provider's order whenever a clock is unresolved.
  // Movement on that leg remains movement; only completed delivery is returned.
  let returning = false;
  for (const event of [...events].reverse()) {
    if (event.provider_code === '2500') returning = true;
    if (!returning) continue;
    event.provider_leg = 'return';
    if (event.stage === 'delivered') event.stage = 'returned';
  }
  const seen = new Set<string>();
  const unique = events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = unique[0]!;
  const mapped = classifyCttExpressStatus(latest.provider_code ?? '');
  const returned = latest.stage === 'returned';
  // A rescheduled delivery day replaces the committed one.
  const rescheduled = clean(data.new_delivery_date, 32);
  const eta = rescheduled || clean(data.committed_delivery_datetime, 32);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eta);
  const validEta = date && calendarDay(Number(date[1]), Number(date[2]), Number(date[3]));
  const latestDay = latest.time ? DateTime.fromISO(latest.time, { setZone: true }).toISODate()
    : typeof latest.local_time === 'string' ? latest.local_time.slice(0, 10) : null;
  const heldForDocuments = history.events.some((row) => isRecord(row) && isRecord(row.detail) && row.detail.incident_type_code === '21_INCT');
  const active = mapped && ['pending', 'in_transit', 'out_for_delivery'].includes(mapped.status) && mapped.stage !== 'ready_for_pickup';
  // The widget uses the committed date as a calendar estimate. Old estimates
  // persist after incidents/returns; do not present those as a current promise.
  const expected = active && latest.provider_leg !== 'return' && !heldForDocuments && validEta && latestDay && validEta >= latestDay ? validEta : null;
  // The weight measured in the network, else the one the sender declared.
  const weight = [data.final_weight, data.declared_weight]
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000);
  // A parcel that entered from another postal network keeps its first number.
  const prime = clean(data.prime_shipping_code, 32);
  return { status: returned ? 'exception' : mapped?.status ?? 'unknown', ...(latest.stage ? { current_stage: latest.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: expected, ...(mapped?.status === 'delivered' && !returned && latest.time ? { delivered_at: latest.time } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...(isValidS10TrackingNumber(prime) ? { international_tracking_number: prime } : {}),
    events: unique.slice(0, 100) };
}
