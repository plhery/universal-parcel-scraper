import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { stages, type Activity } from './status.js';

export const provider = 'pacific-air-cargo';
type Movement = CarrierEvent & { local_time: string; stage: Stage };

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function clock(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d)?)?$/.test(value)) return undefined;
  const date = DateTime.fromISO(value, { zone: 'UTC' });
  return date.isValid && date.year >= 1900 ? value : undefined;
}

function flightNumber(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? String(Number(value)) : undefined;
}

export function parseTracking(html: string, serial: string): CarrierResult {
  const page = load(html);
  if (!page('form[action="/track/"] select[name="AwbPrefix"]').length) {
    throw new SchemaError(provider, 'Pacific Air Cargo did not return its tracking page');
  }
  const script = page('script').toArray().map(node => page(node).text())
    .find(text => /^\s*var trackingData\s*=/.test(text));
  const embedded = script && /^\s*var trackingData\s*=\s*'(\{[\s\S]*\})'\s*;?\s*$/.exec(script)?.[1];
  if (!embedded) throw new IndeterminateError(provider, 'Pacific Air Cargo did not return waybill tracking data');

  let payload: unknown;
  try {
    payload = JSON.parse(embedded);
  } catch (cause) {
    throw new SchemaError(provider, 'Pacific Air Cargo returned unreadable tracking data', { cause });
  }
  if (!isRecord(payload)) throw new SchemaError(provider, 'Pacific Air Cargo returned an unexpected tracking record');
  const legs = rows(payload.PODList).filter(row => row.AWBPrefix === '5YR'
    && typeof row.AWBNumber === 'string' && row.AWBNumber.trim() === serial);
  const first = legs[0];
  if (!first) throw new IndeterminateError(provider, 'Pacific Air Cargo did not confirm the requested waybill');

  const events = new Map<string, Movement>();
  const add = (description: Activity, when: unknown, airport: unknown) => {
    const local_time = clock(when);
    if (!local_time) return;
    const location = typeof airport === 'string' && /^[A-Z]{3}$/.test(airport) ? airport : undefined;
    events.set(JSON.stringify([description, local_time, location]), {
      description, local_time, ...(location && { location }), stage: stages[description], stage_source: 'carrier_map',
    });
  };
  add('Shipment Received', first.DropOffDate, first.Origin);
  const flights = rows(payload.FlightStatusList);
  for (const leg of legs) {
    const flight = flightNumber(leg.FlightNumber);
    const date = clock(leg.FlightDate)?.slice(0, 10);
    if (!flight || !date) continue;
    const legFlights = flights.filter(row => flightNumber(row.FlightNumber) === flight && clock(row.FlightDate)?.slice(0, 10) === date);
    const departed = legFlights.find(row => row.FlightStatus === 'InAir');
    const arrived = legFlights.find(row => row.FlightStatus === 'Landed');
    if (departed) add('Flight Departed', departed.DepartureTime, departed.DepartureAirportCode);
    if (arrived) add('Flight Arrived', arrived.ArrivalTime, arrived.ArrivalAirportCode);
  }

  const last = legs.at(-1);
  const pickedDay = clock(last?.PickDate)?.slice(0, 10);
  if (last && pickedDay && typeof last.PiecesPickedUp === 'number'
    && typeof first.PiecesTendered === 'number' && first.PiecesTendered > 0 && last.PiecesPickedUp >= first.PiecesTendered) {
    const picked = typeof last.PickTime === 'string' && /^\d\d:\d\d(?::\d\d)?$/.test(last.PickTime.trim())
      ? pickedDay + 'T' + last.PickTime.trim() : pickedDay;
    add('Shipment Recovered', picked, last.Destination);
  }

  // The shipment can cross the date line. The carrier's movement sequence
  // supplies the order even when the local clocks compare differently.
  const history = [...events.values()].reverse();
  const latest = history[0];
  if (!latest) throw new IndeterminateError(provider, 'Pacific Air Cargo listed the waybill without a confirmed movement', { reason: 'listed' });
  return {
    status: languageStageStatus(latest.stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events: history,
  };
}
