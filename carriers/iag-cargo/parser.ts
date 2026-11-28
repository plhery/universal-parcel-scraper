import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { arrivalStages, iagCargoPlanned, iagCargoStage, iagCargoWording } from './status.js';

export const provider = 'iag-cargo';

/** The prefixes of the airlines whose cargo IAG Cargo carries: British Airways, Iberia and Aer Lingus. */
export const IAG_CARGO_PREFIXES = ['125', '075', '053'] as const;

const AIRPORT = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const CODE = /^[A-Z]{3,4}$/;
const AIRLINE = /^[A-Z0-9]{2}$/;
const FLIGHT = /^[A-Z0-9]{2}\d{1,5}[A-Z]?$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const STATUSES = new Set(['FINE', 'PARTIAL', 'INCOMPLETE']);
const DISCREPANCIES: ReadonlyMap<string, string> = new Map([['OFLD', 'Offloaded from'], ['SSPD', 'Short-shipped from']]);
const MAX_STATIONS = 50;
const MAX_ROWS = 500;

/**
 * The waybill as the tracker's service takes it, "125-12345675": the prefix of British Airways,
 * Iberia or Aer Lingus, then an eight-digit serial ending in the first seven digits' remainder by seven.
 */
export function normalizeIagCargoNumber(raw: string): string {
  const trimmed = typeof raw === 'string' && raw.length <= 64 ? raw.trim() : '';
  const [, prefix = '', serial = ''] = /^(\d{3})[\s-]?(\d{8})$/.exec(trimmed) ?? [];
  if (!(IAG_CARGO_PREFIXES as readonly string[]).includes(prefix) || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter an IAG Cargo air waybill: 125, 075 or 053, then eight digits');
  }
  return `${prefix}-${serial}`;
}

const invalid = (message: string): never => { throw new SchemaError(provider, message); };

const airportOf = (node: unknown): string => {
  const code = isRecord(node) ? clean(node.locationCode, 10).toUpperCase() : '';
  return AIRPORT.test(code) ? code : '';
};

const flightOf = (value: unknown): string => {
  const flight = clean(value, 12).replace(/\s/g, '').toUpperCase();
  return FLIGHT.test(flight) ? flight : '';
};

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid('IAG Cargo returned an invalid piece count');
}

/** An instant when the service states its zone (it gives UTC with a Z), else the station's wall clock. */
function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const instant = explicitOffsetTime(value);
  if (instant) return { time: instant.iso };
  const wall = WALL_CLOCK.exec(clean(value, 40))?.[1];
  return wall ? { local_time: wall } : invalid('IAG Cargo returned an unreadable event time');
}

type Event = CarrierEvent & { description: string };
interface Row { event: Event; done: boolean; station: string; packages: number | null }

const staged = (code: string, wording: string, clock: Pick<CarrierEvent, 'time' | 'local_time'>, location: string): Event => {
  const stage = iagCargoStage(code);
  return {
    ...clock, description: wording, provider_code: code,
    ...(location && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' as const }),
  };
};

/** The pieces offloaded from, or missing on, a flight, which the tracker lists under a departure. */
function discrepancyRows(value: unknown, fallback: Pick<CarrierEvent, 'time' | 'local_time'> | undefined, station: string): Row[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return invalid('IAG Cargo returned invalid discrepancies');
  return value.flatMap((item): Row[] => {
    if (!isRecord(item)) return invalid('IAG Cargo returned an invalid discrepancy');
    const code = clean(item.discrepancyType, 10).toUpperCase();
    const lead = DISCREPANCIES.get(code);
    const clock = clockOf(item.discrepancyDate) ?? fallback;
    if (!lead || !clock) return [];
    const flight = flightOf(item.flightNumber);
    const packages = count(item.packages);
    const wording = `${flight ? `${lead} ${flight}` : iagCargoWording(code) ?? code}${packages ? `, ${packages} package/s` : ''}`;
    return [{ event: staged(code, wording, clock, station), done: true, station, packages: null }];
  });
}

function stationRows(value: unknown, total: number | null, trucks: ReadonlySet<string>): Row[] {
  if (!isRecord(value)) return invalid('IAG Cargo returned an invalid station');
  const stationCode = airportOf(value.location);
  if (!Array.isArray(value.milestones) || value.milestones.length > MAX_ROWS) return invalid('IAG Cargo returned invalid milestones');
  const rows = value.milestones.flatMap((item): Row[] => {
    if (!isRecord(item)) return invalid('IAG Cargo returned an invalid milestone');
    // The tracker leaves out the copies it marks as duplicated.
    if (item.duplicated === true) return [];
    const code = clean(item.milestoneCode, 10).toUpperCase();
    const status = clean(item.status, 20).toUpperCase();
    if (!CODE.test(code) || !STATUSES.has(status)) return invalid('IAG Cargo returned an invalid milestone');
    const indicator = clean(item.timeIndicator, 2).toUpperCase();
    // An entry not reached, or dated by a scheduled (S) or estimated (E) time rather than an actual (A) one, is still to come.
    const done = status !== 'INCOMPLETE' && indicator !== 'S' && indicator !== 'E';
    // A planned arrival is shown at its arrival time.
    const clock = (!done && code === 'ARR' ? clockOf(item.arrivalTime) : undefined) ?? clockOf(item.eventTime);
    if (done && !clock) return invalid('IAG Cargo returned a milestone without a time');
    const station = airportOf(item.location) || stationCode;
    const flight = flightOf(item.flightNumber);
    const packages = count(item.packages);
    const airline = clean(item.carrierCode, 3).toUpperCase();
    const destination = airportOf(item.sectorDestination);
    let wording = (done ? iagCargoWording(code) : iagCargoPlanned(code, indicator === 'E')) ?? code;
    if ((code === 'DEP' || code === 'ARR') && flight) {
      wording += `, ${trucks.has(flight) ? 'truck no.' : 'flight no.'} ${flight}${code === 'DEP' && destination ? ` to ${destination}` : ''}`;
    }
    if ((code === 'RCT' || code === 'TFD' || code === 'TRM') && AIRLINE.test(airline)) wording += `: ${airline}`;
    if (status === 'PARTIAL' && packages !== null && total !== null && packages > 0 && packages < total) wording += ` (${packages} of ${total} pieces)`;
    const own: Row[] = clock ? [{ event: staged(code, wording, clock, station), done, station, packages }] : [];
    return [...discrepancyRows(item.discrepancies, done ? clock : undefined, station), ...own];
  });
  // Within a station the steps run by their instants when all have one; otherwise in the tracker's order.
  const at = (row: Row) => Date.parse(row.event.time ?? '');
  return rows.every((row) => row.event.time) ? rows.map((row, index) => ({ row, index }))
    .sort((a, b) => at(a.row) - at(b.row) || a.index - b.index).map(({ row }) => row) : rows;
}

/**
 * Reads `GET /tracking/<prefix>-<serial>`, the tracker's reply: the waybill, its stations along
 * the route with their milestones, and the shipment's status. Milestones not reached yet are
 * planned; the stations keep the route's order, since a station's clock may be its own wall clock.
 */
export function parseIagCargo(data: unknown, waybill: string): CarrierResult {
  if (!isRecord(data) || !isRecord(data.awb)) return invalid('IAG Cargo omitted the air waybill');
  const shown = clean(data.awb.awbNumber, 20).replace(/\D/g, '');
  if (shown !== waybill.replace(/\D/g, '')) throw new IndeterminateError(provider, 'IAG Cargo answered for another air waybill');
  const total = count(data.awb.totalPackages);
  const origin = clean(data.awb.originCode, 10).toUpperCase();
  const destination = clean(data.awb.destinationCode, 10).toUpperCase();
  const stations = data.journeyStations ?? [];
  if (!Array.isArray(stations) || stations.length > MAX_STATIONS) return invalid('IAG Cargo returned an invalid route');
  const transports = Array.isArray(data.transportInfos) ? data.transportInfos.slice(0, 100) : [];
  const trucks = new Set(transports.filter((info) => isRecord(info) && info.truckTransport === true)
    .map((info) => flightOf((info as Record<string, unknown>).flightNumber)).filter(Boolean));
  const details = isRecord(data.shipmentStatusDetails) ? data.shipmentStatusDetails : {};
  const summary = clean(details.status, 40).toUpperCase();

  const rows: Row[] = [];
  const booked = clockOf(details.bookingDateTime);
  const origins = AIRPORT.test(origin) ? origin : '';
  if (booked) rows.push({ event: staged('BOOKED', iagCargoWording('BOOKED')!, booked, origins), done: true, station: origins, packages: null });
  let destinationCountry = '';
  for (const station of stations) {
    rows.push(...stationRows(station, total, trucks));
    if (rows.length > MAX_ROWS) return invalid('IAG Cargo returned too many milestones');
    const location = isRecord(station) && isRecord(station.location) ? station.location : {};
    const country = clean(location.countryCode, 4).toUpperCase();
    if (destination && airportOf(location) === destination && COUNTRY.test(country)) destinationCountry = country;
  }
  const cancelled = summary === 'CANCELLED' ? clockOf(details.statusUpdatedDateTime) : undefined;
  if (cancelled) rows.push({ event: staged('CANCELLED', iagCargoWording('CANCELLED')!, cancelled, ''), done: true, station: '', packages: null });

  for (const row of rows) {
    // A notice or a delivery away from the destination is a step on the way.
    if (AIRPORT.test(destination) && row.station && row.station !== destination && arrivalStages.has(row.event.stage as Stage)) {
      row.event.stage = 'in_transit';
    }
  }
  const planned = plannedEvents(rows.filter((row) => !row.done).map((row) => row.event));
  const done = rows.filter((row) => row.done).reverse();
  const seen = new Set<string>();
  const unique = done.filter((row) => {
    const key = JSON.stringify([row.event.provider_code, row.event.description, row.event.time, row.event.local_time, row.event.location]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  const extra = {
    ...(destinationCountry && { destination_country: destinationCountry }),
    ...(planned.length && { planned_events: planned }),
  };
  if (!unique.length) {
    throw new NoHistoryError(provider, 'IAG Cargo lists the air waybill without events', { reason: 'listed', plannedEvents: planned });
  }

  // A waybill delivered in parts is delivered once its delivered pieces reach its total; until then its latest other stage leads.
  const deliveries = unique.filter((row) => row.event.stage === 'delivered');
  const whole = deliveries.some((row) => row.packages === null || total === null || row.packages >= total)
    || (total !== null && deliveries.reduce((sum, row) => sum + (row.packages ?? 0), 0) >= total);
  const latest = unique.filter((row) => row.event.stage);
  const current = (cancelled ? unique[0] : whole ? deliveries[0] : latest.find((row) => row.event.stage !== 'delivered'))?.event
    ?? latest[0]?.event ?? unique[0]!.event;
  const stage = current.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' as const }),
    last_status_text: current.description,
    ...(current.provider_code && { provider_code: current.provider_code }),
    last_update: current.time ?? null,
    ...(current.local_time && { last_update_local: current.local_time }),
    ...extra,
    events: unique.map((row) => row.event),
  };
}

/** The service's answer to a waybill it does not hold: "There was no AWB found with the following number: 125-12345675." */
export function isIagCargoNotFound(body: string, waybill: string): boolean {
  const named = /^\s*"?There was no AWB found with the following number:\s*(\d{3}-\d{8})\.?"?\s*$/.exec(body)?.[1];
  return named === waybill;
}

export function notFound(): never {
  throw new NotFoundError(provider, 'IAG Cargo has no shipment under this air waybill');
}
