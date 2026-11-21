import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { cargoluxActual, cargoluxPlanned, cargoluxStage } from './status.js';

export const PROVIDER = 'cargolux';
// A waybill's history is a few kilobytes.
export const CARGOLUX_MAX_BYTES = 256 * 1024;

/** Cargolux's waybill prefixes: 172 for Cargolux, 356 for Cargolux Italia. */
export const CARGOLUX_PREFIXES = ['172', '356'] as const;

const AIRPORT = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const CODE = /^[A-Z]{3}$/;
const MAX_AIRPORTS = 50;
const MAX_EVENTS = 500;
// The stages that hold only at the waybill's destination; elsewhere the shipment is still on its way.
const ARRIVAL_STAGES = new Set<Stage>(['ready_for_pickup', 'delivered']);

/**
 * The whole waybill, as the tracker asks for it: "172-87779521". Its prefix is 172 or 356, and
 * Cargolux's when left out; the serial ends in its check digit, the first seven digits' remainder by seven.
 */
export function normalizeCargoluxWaybill(raw: string): string {
  const trimmed = typeof raw === 'string' && raw.length <= 64 ? raw.trim() : '';
  const digits = /^[\d\s-]+$/.test(trimmed) ? trimmed.replace(/[\s-]/g, '') : '';
  const prefix = digits.length === 11 ? digits.slice(0, 3) : CARGOLUX_PREFIXES[0];
  const serial = digits.length === 11 ? digits.slice(3) : digits;
  if (!(CARGOLUX_PREFIXES as readonly string[]).includes(prefix) || !/^\d{8}$/.test(serial) || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(PROVIDER, 'Enter a Cargolux air waybill: 172 or 356, then eight digits');
  }
  return `${prefix}-${serial}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function optionalText(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid('Cargolux returned an invalid field');
}

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid('Cargolux returned an invalid piece count');
}

interface Scan { at: number; index: number; event: CarrierEvent & { time: string; description: string }; code: string; pieces: number | null; airport: string; processed: boolean }

function scanOf(value: unknown, airport: string, location: string, total: number | null, index: number): Scan {
  if (!isRecord(value)) return invalid('Cargolux returned an invalid event');
  const code = typeof value.eventType === 'string' ? value.eventType.trim().toUpperCase() : '';
  const clock = explicitOffsetTime(value.time);
  if (!CODE.test(code) || !clock) return invalid('Cargolux returned an invalid event');
  if (typeof value.isProcessed !== 'boolean' || (value.isTruck !== undefined && value.isTruck !== null && typeof value.isTruck !== 'boolean')) {
    return invalid('Cargolux returned an invalid event');
  }
  const processed = value.isProcessed;
  const flight = optionalText(value.flightNumber, 20);
  const pieces = count(value.pieces);
  const wording = (processed ? cargoluxActual(code) : cargoluxPlanned(code)) ?? code;
  // The tracker names a flight for its moves, and a road feeder service by a truck or a flight number ending in Z.
  const vehicle = flight ? ` ${value.isTruck === true || /Z$/.test(flight) ? 'by truck' : 'on'} ${flight}` : '';
  const part = pieces !== null && total !== null && pieces > 0 && pieces < total ? ` (${pieces} of ${total} pieces)` : '';
  const stage = cargoluxStage(code);
  return {
    at: clock.timestamp, index, code, pieces, airport, processed,
    event: { time: clock.iso, description: `${wording}${vehicle}${part}`, location, provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) },
  };
}

function trackingOf(payload: unknown, waybill: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.trackings) || !Array.isArray(payload.invalidAwbNumbers)
    || payload.trackings.length > 50 || payload.invalidAwbNumbers.length > 50) return invalid('Cargolux returned an unreadable reply');
  if (payload.invalidAwbNumbers.includes(waybill)) throw new InvalidInputError(PROVIDER, 'Cargolux refuses this air waybill');
  if (payload.trackings.length === 0) return invalid('Cargolux returned no answer for the air waybill');
  const rows = payload.trackings.filter((row) => isRecord(row) && row.awbNumber === waybill);
  if (rows.length !== 1) throw new IndeterminateError(PROVIDER, 'Cargolux answered for another air waybill');
  return rows[0] as Record<string, unknown>;
}

/**
 * Reads the reply of `GET /api/track/awbs/?numbers=<waybill>` for one waybill. A waybill the
 * tracker does not hold comes back with an empty summary and no airports. Events carry the
 * station's own offset; steps the tracker has not processed yet are planned, not scans. The
 * agent, the goods' description, the handling codes, weights and volumes stay behind.
 */
export function parseCargolux(payload: unknown, waybill: string): CarrierResult {
  const tracking = trackingOf(payload, waybill);
  const summary = tracking.shipmentSummary, airports = tracking.airportEvents;
  if ((summary === null || summary === undefined) && (airports === null || airports === undefined || (Array.isArray(airports) && airports.length === 0))) {
    throw new NotFoundError(PROVIDER, 'Cargolux has no shipment under this air waybill');
  }
  if (!isRecord(summary)) return invalid('Cargolux returned an invalid shipment summary');
  if (summary.awb !== undefined && summary.awb !== null && summary.awb !== waybill) {
    throw new IndeterminateError(PROVIDER, 'Cargolux answered for another air waybill');
  }
  const destination = optionalText(summary.destination, 20);
  if (destination && !AIRPORT.test(destination)) return invalid('Cargolux returned an invalid destination');
  const total = count(summary.statedPieces);
  if (airports !== null && airports !== undefined && (!Array.isArray(airports) || airports.length > MAX_AIRPORTS)) {
    return invalid('Cargolux returned an invalid route');
  }

  let destinationCountry = '';
  const scans: Scan[] = [];
  for (const value of (airports ?? []) as unknown[]) {
    if (!isRecord(value) || !Array.isArray(value.events)) return invalid('Cargolux returned an invalid airport');
    const airport = typeof value.airportCode === 'string' ? value.airportCode.trim() : '';
    const country = optionalText(value.countryIso, 20);
    if (!AIRPORT.test(airport) || (country && !COUNTRY.test(country))) return invalid('Cargolux returned an invalid airport');
    if (airport === destination && country) destinationCountry = country;
    const city = optionalText(value.cityName, 80);
    const location = city ? `${city} (${airport})` : airport;
    for (const event of value.events) scans.push(scanOf(event, airport, location, total, scans.length));
    if (scans.length > MAX_EVENTS) return invalid('Cargolux returned too many events');
  }

  for (const scan of scans) {
    // A notice, documents handed over or a delivery away from the destination is a step on the way.
    if (destination && scan.airport !== destination && ARRIVAL_STAGES.has(scan.event.stage as Stage)) scan.event.stage = 'in_transit';
  }
  const planned = plannedEvents(scans.filter((scan) => !scan.processed).map((scan) => scan.event));
  const seen = new Set<string>();
  // Newest first by instant; events the tracker dates alike keep the order it lists them in.
  const done = scans.filter((scan) => scan.processed).sort((a, b) => b.at - a.at || b.index - a.index).filter((scan) => {
    const key = JSON.stringify([scan.at, scan.code, scan.event.location, scan.event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  const extra = {
    ...(destinationCountry ? { destination_country: destinationCountry } : {}),
    ...(planned.length ? { planned_events: planned } : {}),
  };
  if (done.length === 0) throw new NoHistoryError(PROVIDER, 'Cargolux lists the air waybill without events', { reason: 'listed', plannedEvents: planned });

  // A waybill delivered in parts is delivered once its delivered pieces reach its total; until then its latest other stage leads.
  const deliveries = done.filter((scan) => scan.event.stage === 'delivered');
  const whole = deliveries.some((scan) => scan.pieces === null || total === null || scan.pieces >= total)
    || (total !== null && deliveries.reduce((sum, scan) => sum + (scan.pieces ?? 0), 0) >= total);
  const staged = done.filter((scan) => scan.event.stage);
  const current = (whole ? staged[0] : staged.find((scan) => scan.event.stage !== 'delivered') ?? staged[0])?.event.stage as Stage | undefined;
  const newest = done[0]!.event;
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current ? { current_stage: current, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...extra,
    events: done.map((scan) => scan.event),
  };
}
