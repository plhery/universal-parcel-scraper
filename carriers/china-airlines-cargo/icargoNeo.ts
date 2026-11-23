import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

/** An airline's public iCargo Neo portal, whose GraphQL gateway answers guest tracking queries. */
export interface IcargoNeoPortal {
  provider: string;
  /** The service's name in error messages. */
  name: string;
  /** The airline's waybill prefix. */
  prefix: string;
  /** The portal's origin, where its gateway answers. */
  origin: string;
  activityStage: (code: string) => Stage | undefined;
  activityWording: (code: string) => string | undefined;
}

const AIRPORT = /^[A-Z]{3}$/;
const CODE = /^[A-Z]{3}$/;
const MAX_ROWS = 500;

/** The whole waybill as the tracker asks for it, eleven digits: the prefix, then a serial whose eighth digit is the first seven's remainder by seven. */
export function normalizeIcargoNeoWaybill(raw: string, { provider, name, prefix }: IcargoNeoPortal): string {
  const trimmed = raw.length <= 64 ? raw.trim() : '';
  const digits = /^[\d\s-]+$/.test(trimmed) ? trimmed.replace(/[\s-]/g, '') : '';
  const serial = digits.length === 11 && digits.startsWith(prefix) ? digits.slice(3) : digits;
  if (!/^\d{8}$/.test(serial) || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, `Enter a ${name} air waybill: ${prefix}, then eight digits`);
  }
  return prefix + serial;
}

export const loginRequest = {
  operationName: 'loginAsAnonymousUser',
  variables: {},
  query: 'mutation loginAsAnonymousUser { loginAsAnonymousUser { security { id_token exp } } }',
};

export const summaryRequest = (waybill: string) => ({
  operationName: 'GetShipmentsByAwbs',
  variables: { shipmentNumbers: [waybill] },
  query: 'query GetShipmentsByAwbs($shipmentNumbers: [String]!) { GetShipmentsByAwbs(shipmentNumbers: $shipmentNumbers) '
    + '{ awb_number pieces origin_airport_code destination_airport_code milestones { milestone status } } }',
});

export const activityRequest = (waybill: string) => ({
  operationName: 'GetShipmentActivityByAwb',
  variables: { shipmentNumber: waybill },
  query: 'query GetShipmentActivityByAwb($shipmentNumber: String!) { GetShipmentActivityByAwb(shipmentNumber: $shipmentNumber) '
    + '{ items { event pieces airport_code event_time flight { flight_carrier_code flight_number flight_date } } } }',
});

function readData(body: string, { provider, name }: IcargoNeoPortal): Record<string, unknown> {
  const invalid = (message: string): never => { throw new SchemaError(provider, message); };
  if (/^\s*</.test(body)) {
    if (/Access Denied|Reference #|cf-chl|<title>\s*(?:Just a moment|Security Check)/i.test(body)) {
      throw new ChallengeError(provider, `${name} requires verification`);
    }
    return invalid(`${name} returned a page instead of tracking data`);
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return invalid(`${name} did not return tracking JSON`);
  }
  if (!isRecord(reply)) return invalid(`${name} returned an unreadable reply`);
  if (Array.isArray(reply.errors) && reply.errors.length) {
    const code = reply.errors.map(error => (isRecord(error) && typeof error.error_code === 'string' ? error.error_code : '')).find(Boolean);
    return invalid(`${name} refused the guest query${code ? ` (${code.slice(0, 80)})` : ''}`);
  }
  return isRecord(reply.data) ? reply.data : invalid(`${name} omitted its tracking data`);
}

/** The anonymous session's token, from the portal's guest sign-in. */
export function guestToken(body: string, portal: IcargoNeoPortal): string {
  const login = readData(body, portal).loginAsAnonymousUser;
  const security = isRecord(login) ? login.security : null;
  const token = isRecord(security) ? security.id_token : null;
  if (typeof token === 'string' && token.length <= 8192 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return token;
  throw new SchemaError(portal.provider, `${portal.name} did not open a guest session`);
}

function flightOf(value: unknown): string {
  if (!isRecord(value)) return '';
  const carrier = typeof value.flight_carrier_code === 'string' ? value.flight_carrier_code.trim() : '';
  const number = typeof value.flight_number === 'string' ? value.flight_number.trim() : '';
  return /^[A-Z\d]{2}$/.test(carrier) && /^\d{1,4}[A-Z]?$/.test(number) ? carrier + number : '';
}

const PREPOSITION: Readonly<Record<string, string>> = { DEP: 'on', ARR: 'on', DIS: 'from', RCF: 'from' };

interface Row { code: string; airport: string; localTime: string; flight: string; pieces: number }

function rowOf(value: unknown, { provider, name }: IcargoNeoPortal): Row | null {
  const invalid = (message: string): never => { throw new SchemaError(provider, message); };
  if (!isRecord(value) || typeof value.event !== 'string') return invalid(`${name} returned an invalid activity`);
  const code = value.event.trim().toUpperCase();
  if (!CODE.test(code)) return invalid(`${name} returned an invalid activity code`);
  if (value.event_time === null || value.event_time === undefined) return null;
  if (typeof value.event_time !== 'string') return invalid(`${name} returned an invalid activity time`);
  // A station's wall clock without its offset: "16 Mar 2026, 18:08:00".
  const time = DateTime.fromFormat(value.event_time.trim(), 'd MMM yyyy, HH:mm:ss', { zone: 'utc', locale: 'en' });
  if (!time.isValid) return invalid(`${name} returned an invalid activity time`);
  const airport = typeof value.airport_code === 'string' ? value.airport_code.trim() : '';
  const pieces = typeof value.pieces === 'number' && Number.isSafeInteger(value.pieces) && value.pieces > 0 ? value.pieces : 0;
  return { code, airport: AIRPORT.test(airport) ? airport : '', localTime: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"), flight: flightOf(value.flight), pieces };
}

/**
 * Reads the portal's two guest queries for one waybill. The activity list comes newest first, each row on
 * its station's clock. Like the portal, an arrival or departure counts once per flight, its newest record;
 * bookings and other rows at one station and minute become one event naming their flights.
 */
export function parseIcargoNeoTracking(summaryBody: string, activityBody: string, waybill: string, portal: IcargoNeoPortal): CarrierResult {
  const { provider, name } = portal;
  const shipments = readData(summaryBody, portal).GetShipmentsByAwbs;
  const activity = readData(activityBody, portal).GetShipmentActivityByAwb;
  const items = isRecord(activity) ? activity.items : null;
  if (!Array.isArray(shipments) || !Array.isArray(items) || items.length > MAX_ROWS) {
    throw new SchemaError(provider, `${name} omitted the shipment or its activity`);
  }
  if (!shipments.length && !items.length) throw new NotFoundError(provider);
  const shipment: unknown = shipments.length === 1 ? shipments[0] : null;
  if (!isRecord(shipment) || shipment.awb_number !== waybill) {
    throw new IndeterminateError(provider, `${name} did not confirm the full air waybill`);
  }
  const destination = typeof shipment.destination_airport_code === 'string' ? shipment.destination_airport_code.trim() : '';
  const total = typeof shipment.pieces === 'number' && Number.isSafeInteger(shipment.pieces) && shipment.pieces > 0 ? shipment.pieces : 0;
  const milestones = Array.isArray(shipment.milestones) ? shipment.milestones : [];
  const deliveredMilestone = milestones.some(item => isRecord(item) && item.milestone === 'DELIVERED' && item.status === 'done');

  const movedOnce = new Set<string>();
  const merged = new Map<string, Row & { flights: string[] }>();
  for (const value of items) {
    const row = rowOf(value, portal);
    if (!row) continue;
    if ((row.code === 'ARR' || row.code === 'DEP') && row.flight) {
      const leg = `${row.code} ${row.flight} ${isRecord(value) && isRecord(value.flight) ? String(value.flight.flight_date) : ''}`;
      if (movedOnce.has(leg)) continue;
      movedOnce.add(leg);
    }
    const key = `${row.code} ${row.airport} ${row.localTime.slice(0, 16)}`;
    const existing = merged.get(key);
    if (!existing) merged.set(key, { ...row, flights: row.flight ? [row.flight] : [] });
    else if (row.flight && !existing.flights.includes(row.flight)) existing.flights.push(row.flight);
  }

  // Every piece delivered at the destination, or the tracker's own delivered milestone, completes the waybill.
  const deliveredPieces = [...merged.values()]
    .filter(row => row.code === 'DLV' && row.airport === destination).reduce((sum, row) => sum + row.pieces, 0);
  const complete = deliveredMilestone || (total > 0 && deliveredPieces >= total);
  // The tracker books later legs, and rebooks them, while the goods travel: a booking after the
  // acceptance or a move keeps the stage before it.
  const rows = [...merged.values()];
  const progressed = new Set<Row>();
  let moved = false;
  for (const row of [...rows].reverse()) {
    if (moved) progressed.add(row);
    const stage = portal.activityStage(row.code);
    if (stage && stage !== 'registered') moved = true;
  }
  const events: CarrierEvent[] = rows.map(row => {
    let stage: Stage | undefined = portal.activityStage(row.code);
    if (stage === 'registered' && progressed.has(row)) stage = undefined;
    if (stage === 'delivered' && (!complete || (destination && row.airport !== destination))) stage = 'in_transit';
    const wording = portal.activityWording(row.code) ?? row.code;
    const flights = row.flights.length ? ` ${PREPOSITION[row.code] ?? 'for'} ${row.flights.join(', ')}` : '';
    return {
      local_time: row.localTime, description: wording + flights, provider_code: row.code,
      ...(row.airport && { location: row.airport }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  });

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, `${name} listed the waybill without dated activity`, { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description ?? null, last_update_local: latest.local_time ?? null, events,
  };
}

/** Tracks a waybill on the portal: a guest sign-in, then its summary and activity with the portal's own named operations. */
export const icargoNeoAdapter = (portal: IcargoNeoPortal): AdapterFactory => environment => ({
  id: portal.provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const { provider, name, origin } = portal;
    const waybill = normalizeIcargoNeoWaybill(input.number, portal);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const options = { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [403] };
        const headers = {
          Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin, Referer: `${origin}/icargoneoportal/app/main/`,
          'User-Agent': userAgentOf(environment.userAgent),
        };
        const post = async (body: object, token?: string) => {
          const { bytes, response } = await fetchBounded(`${origin}/portalgateway/graphql`, {
            method: 'POST', signal, body: JSON.stringify(body),
            headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
          }, options);
          if (response.status === 403) throw new ChallengeError(provider, `${name} refused the guest tracking request`);
          return decodeText(bytes);
        };
        // The portal's guest sign-in opens an anonymous session; the gateway answers only the portal's named operations.
        const token = guestToken(await post(loginRequest), portal);
        const [summary, activity] = await Promise.all([post(summaryRequest(waybill), token), post(activityRequest(waybill), token)]);
        return parseIcargoNeoTracking(summary, activity, waybill, portal);
      },
    }]);
  },
});
