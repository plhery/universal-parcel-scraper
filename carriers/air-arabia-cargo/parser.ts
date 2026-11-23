import { DateTime } from 'luxon';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { activityStage, activityWording } from './status.js';

export const provider = 'air-arabia-cargo';
const MAX_ROWS = 500;

/** The group airlines whose waybills the official tracker reads, by waybill prefix, with each one's API path. */
export const AIRLINES: Readonly<Record<string, string>> = {
  '514': 'g9', // Air Arabia
  '049': '3l', // Air Arabia Abu Dhabi
  '452': '3o', // Air Arabia Maroc
  '844': 'e5', // Air Arabia Egypt
  '772': '9p', // Fly Jinnah
};

export interface Waybill { prefix: string; serial: string }

/** A group airline's waybill: its prefix, then a serial whose eighth digit is the first seven's remainder by seven. A serial alone is Air Arabia's. */
export function normalizeWaybill(raw: string): Waybill {
  const trimmed = raw.length <= 64 ? raw.trim() : '';
  const digits = /^[\d\s-]+$/.test(trimmed) ? trimmed.replace(/[\s-]/g, '') : '';
  const [prefix, serial] = digits.length === 11 ? [digits.slice(0, 3), digits.slice(3)] : ['514', digits];
  if (!AIRLINES[prefix] || !/^\d{8}$/.test(serial) || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter an Air Arabia Cargo air waybill: 514, or another Air Arabia group prefix, then eight digits');
  }
  return { prefix, serial };
}

const invalid = (message: string): never => { throw new SchemaError(provider, message); };

function readReply(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return invalid('Air Arabia Cargo did not return tracking JSON');
  }
}

const PREPOSITION: Readonly<Record<string, string>> = { DEP: 'on', ARR: 'on', PRE: 'on', MAN: 'on', RCF: 'from' };

interface Row { code: string; airport: string; time: string; at: number; flight: string; pieces: number }

function rowOf(value: unknown): Row | null {
  if (!isRecord(value) || typeof value.event_type !== 'string') return invalid('Air Arabia Cargo returned an invalid activity');
  const code = value.event_type.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return invalid('Air Arabia Cargo returned an invalid activity code');
  if (value.transaction_date === null || value.transaction_date === undefined) return null;
  // The station's clock with its offset: "2024-02-09T19:40:20+05:00".
  const written = typeof value.transaction_date === 'string' ? value.transaction_date.trim() : '';
  const time = /[+-]\d{2}:\d{2}$|Z$/.test(written) ? DateTime.fromISO(written, { setZone: true }) : DateTime.invalid('no offset');
  if (!time.isValid) return invalid('Air Arabia Cargo returned an invalid activity time');
  const airport = typeof value.airport_code === 'string' && /^[A-Z]{3}$/.test(value.airport_code.trim()) ? value.airport_code.trim() : '';
  const flightNumber = isRecord(value.flight_details) ? value.flight_details.flight_number : null;
  const flight = typeof flightNumber === 'string' && /^[A-Z\d]{2}\d{1,4}[A-Z]?$/.test(flightNumber.trim()) ? flightNumber.trim() : '';
  const pieces = typeof value.pieces === 'number' && Number.isSafeInteger(value.pieces) && value.pieces > 0 ? value.pieces : 0;
  return {
    code, airport, flight, pieces,
    time: time.toISO({ suppressMilliseconds: true, includeOffset: true }), at: time.toMillis(),
  };
}

/**
 * Reads the tracker's answer for one waybill. Its history comes oldest first with each station's offset
 * and repeats some records; the adapter drops the repeats and a booking re-saved unchanged, then lists
 * the newest first.
 */
export function parseTracking(body: string, status: number, waybill: Waybill): CarrierResult {
  const reply = readReply(body);
  if (status === 400 || Array.isArray(reply)) {
    const codes = (Array.isArray(reply) ? reply : [reply])
      .map(item => (isRecord(item) && typeof item.error_code === 'string' ? item.error_code.trim() : ''));
    if (codes.includes('ICO_TRK_001')) throw new NotFoundError(provider);
    return invalid(`Air Arabia Cargo refused the tracking request${codes[0] ? ` (${codes[0].slice(0, 40)})` : ''}`);
  }
  if (!isRecord(reply) || !isRecord(reply.shipment_summary) || !Array.isArray(reply.shipment_history)) {
    return invalid('Air Arabia Cargo omitted the shipment or its history');
  }
  const summary = reply.shipment_summary;
  if (summary.awb !== `${waybill.prefix}-${waybill.serial}`) {
    throw new IndeterminateError(provider, 'Air Arabia Cargo did not confirm the full air waybill');
  }
  if (reply.shipment_history.length > MAX_ROWS) return invalid('Air Arabia Cargo returned too long a history');
  const destination = typeof summary.destination === 'string' ? summary.destination.trim() : '';
  const total = typeof summary.stated_pieces === 'number' && Number.isSafeInteger(summary.stated_pieces) && summary.stated_pieces > 0
    ? summary.stated_pieces : 0;

  const rows: Row[] = [];
  const seen = new Set<string>();
  let booking = '';
  for (const value of reply.shipment_history) {
    const row = rowOf(value);
    if (!row) continue;
    const key = `${row.code} ${row.airport} ${row.time} ${row.flight} ${row.pieces}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.code === 'BKD') {
      // The tracker records a booking again each time it is saved; only a change of flight, station or pieces is news.
      const plan = `${row.airport} ${row.flight} ${row.pieces}`;
      if (plan === booking) continue;
      booking = plan;
    }
    rows.push(row);
  }

  // Every stated piece delivered at the destination completes the waybill.
  const deliveredPieces = rows.filter(row => row.code === 'DLV' && row.airport === destination).reduce((sum, row) => sum + row.pieces, 0);
  const complete = total > 0 && deliveredPieces >= total;
  // A booking after the acceptance or a move keeps the stage before it.
  let moved = false;
  const events: CarrierEvent[] = rows.map(row => {
    let stage: Stage | undefined = activityStage(row.code);
    if (stage === 'registered' && moved) stage = undefined;
    if (stage && stage !== 'registered') moved = true;
    if (stage === 'delivered' && (!complete || row.airport !== destination)) stage = 'in_transit';
    const wording = activityWording(row.code) ?? row.code;
    const flight = row.flight ? ` ${PREPOSITION[row.code] ?? 'for'} ${row.flight}` : '';
    return {
      time: row.time, description: wording + flight, provider_code: row.code,
      ...(row.airport && { location: row.airport }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse();

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Air Arabia Cargo listed the waybill without dated activity', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description ?? null, last_update: latest.time ?? null, events,
  };
}
