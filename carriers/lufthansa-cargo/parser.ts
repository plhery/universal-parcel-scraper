import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { arrivalStages, lufthansaCargoDiscrepancy, lufthansaCargoStage, lufthansaCargoWording } from './status.js';

export const provider = 'lufthansa-cargo';
export const PREFIX = '020';

const AIRPORT = /^[A-Z]{3}$/;
const CODE = /^[A-Z]{3}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const MAX_ROWS = 500;

/** Lufthansa Cargo's prefix 020, then an eight-digit serial ending in the first seven digits' remainder by seven. */
export function normalizeLufthansaCargoNumber(raw: string): string {
  const [, serial = ''] = /^(?:020[\s-]?)?(\d{8})$/.exec(typeof raw === 'string' ? raw.trim() : '') ?? [];
  if (!serial || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter a Lufthansa Cargo air waybill beginning with 020');
  }
  return PREFIX + serial;
}

const invalid = (message: string): never => { throw new SchemaError(provider, message); };

const airport = (node: unknown): string => {
  const code = isRecord(node) ? clean(node.airportCode, 10).toUpperCase() : '';
  return AIRPORT.test(code) ? code : '';
};

function flightOf(node: unknown): string {
  const designator = isRecord(node) && isRecord(node.flightDesignator) ? node.flightDesignator : undefined;
  if (!designator) return '';
  const number = `${clean(designator.carrierCode, 3)}${clean(designator.flightNumber, 5)}${clean(designator.suffix, 1)}`.toUpperCase();
  return /^[A-Z0-9]{2}\d{1,5}[A-Z]?$/.test(number) ? number : '';
}

/** The station's clock with its offset as the tracker gives it, or its wall clock when it gives none. */
function clockOf(node: unknown): Pick<CarrierEvent, 'time' | 'local_time'> | undefined {
  const value = isRecord(node) ? node.eventDateTime : undefined;
  if (value === null || value === undefined || value === '') return undefined;
  const instant = explicitOffsetTime(value);
  if (instant) return { time: instant.iso };
  const wall = WALL_CLOCK.exec(clean(value, 40))?.[1];
  return wall ? { local_time: wall } : invalid('Lufthansa Cargo returned an unreadable event time');
}

interface Row { event: CarrierEvent & { description: string }; done: boolean; station: string }

function rowOf(value: unknown): Row {
  if (!isRecord(value)) return invalid('Lufthansa Cargo returned an invalid status row');
  // The tracker shows a row without an event type as a discrepancy.
  const code = value.cargoEventType === null || value.cargoEventType === undefined ? 'DIS' : clean(value.cargoEventType, 10).toUpperCase();
  if (!CODE.test(code)) return invalid('Lufthansa Cargo returned an invalid event type');
  const station = airport(value.stationAirport);
  const flight = flightOf(value.flight);
  const actual = clockOf(value.actualCargoEvent);
  const planned = clockOf(value.planedCargoEvent);
  const discrepancy = isRecord(value.actualCargoEvent) ? clean(value.actualCargoEvent.discrepancyCode, 10).toUpperCase() : '';
  const wording = (code === 'DIS' && lufthansaCargoDiscrepancy(discrepancy, Boolean(flight))) || lufthansaCargoWording(code) || code;
  const stage = lufthansaCargoStage(code);
  const clock = actual ?? planned;
  if (!clock) return invalid('Lufthansa Cargo returned a status row without a time');
  return {
    done: Boolean(actual), station,
    event: {
      ...clock,
      description: flight && code !== 'BKD' ? `${wording}, flight ${flight}` : wording,
      provider_code: code,
      ...(station && { location: station }),
      ...(stage && { stage, stage_source: 'carrier_map' as const }),
    },
  };
}

/**
 * Reads `GET /stp/shipments-details/<prefix><serial>`. The reply names the waybill it answers;
 * one the guest tracker does not show comes back unavailable with no history. Each status row
 * holds its planned and actual event, with the station's clock; rows not done yet are planned.
 */
export function parseLufthansaCargo(data: unknown, number: string): CarrierResult {
  if (!isRecord(data) || !isRecord(data.awbNumber)) return invalid('Lufthansa Cargo omitted the air waybill');
  const shown = `${clean(data.awbNumber.airlineCode, 3)}${clean(data.awbNumber.serialNumber, 8)}`;
  if (shown !== number) throw new IndeterminateError(provider, 'Lufthansa Cargo answered for another air waybill');
  const available = isRecord(data.availabilityDetails) ? data.availabilityDetails.isAvailable : undefined;
  // The page words it "The AWB has not been found or requires login."
  if (available === false) throw new NotFoundError(provider, 'Lufthansa Cargo does not show this air waybill to guests');
  if (available !== true) return invalid('Lufthansa Cargo did not say whether it holds the air waybill');
  const history = data.statusHistories ?? [];
  if (!Array.isArray(history) || history.length > MAX_ROWS) return invalid('Lufthansa Cargo returned an invalid status history');

  const destination = isRecord(data.awbDetails) ? airport(data.awbDetails.destinationAirport) : '';
  const rows = history.map(rowOf);
  for (const row of rows) {
    // A notice or a delivery away from the destination is a step on the way.
    if (destination && row.station && row.station !== destination && arrivalStages.has(row.event.stage as Stage)) row.event.stage = 'in_transit';
  }
  const planned = plannedEvents(rows.filter(row => !row.done).map(row => row.event));
  const seen = new Set<string>();
  // The tracker lists the rows in the shipment's order, the oldest first.
  const events = rows.filter(row => row.done).map(row => row.event).reverse().filter(event => {
    const key = JSON.stringify([event.provider_code, event.description, event.time, event.local_time, event.location]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  if (!events.length) {
    throw new NoHistoryError(provider, 'Lufthansa Cargo lists the air waybill without events', { reason: 'listed', plannedEvents: planned });
  }
  // A row recorded after the delivery does not take it back.
  const current = events.find(event => event.stage === 'delivered') ?? events.find(event => event.stage) ?? events[0]!;
  const stage = current.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description,
    ...(current.provider_code && { provider_code: current.provider_code }),
    last_update: current.time ?? null,
    ...(current.local_time && { last_update_local: current.local_time }),
    events,
    ...(planned.length && { planned_events: planned }),
  };
}
