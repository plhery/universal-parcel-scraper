import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { kmtcStage, kmtcWording } from './status.js';

export const PROVIDER = 'KMTC';
/** The service behind KMTC's cargo tracking page, answered with JSON. */
export const KMTC_API = 'https://api.ekmtc.com/trans/trans';
export const KMTC_MAX_BYTES = 2_000_000;
/** The containers of a bill whose moves are asked; the others are left out. */
export const MAX_DETAILS = 6;
const MAX_ROWS = 500;

// A bill is three letters for the office and seven digits; US import records put KORP, the SCAC
// KMTC files them under, before it. A booking is two letters for the country and eight digits.
const BILL = /^(?:KORP)?([A-Z]{3}\d{7})$/;
const BOOKING = /^[A-Z]{2}\d{8}$/;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;

/** What KMTC's page tracks for a guest: a bill of lading (BL) or a booking (BK). */
export type KmtcQuery = { kind: 'BL' | 'BK'; number: string };

export function kmtcQuery(raw: string): KmtcQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'BL', number: bill };
  if (BOOKING.test(number)) return { kind: 'BK', number };
  throw new InvalidInputError(PROVIDER, 'KMTC tracks a bill of lading of three letters and seven digits or a booking of two letters and eight digits');
}

const text = (row: Record<string, unknown>, key: string, max = 200) => {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `KMTC returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
};
const list = (reply: Record<string, unknown>, key: string, max = MAX_ROWS) => {
  const value = reply[key] ?? [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `KMTC returned an invalid ${key}`);
  return value as Record<string, unknown>[];
};

/** A container of the shipment, with the bill and booking KMTC lists it under. */
export type KmtcContainer = { container: string; bill: string; booking: string };

/**
 * The containers KMTC lists for a bill or booking, once each, or none when it holds no such
 * number. KMTC answers no containers too while its search is closed, which it marks.
 */
export function kmtcContainers(reply: unknown, query: KmtcQuery): KmtcContainer[] | null {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'KMTC returned an invalid search reply');
  const rows = list(reply, 'cntrList');
  if (!rows.length) {
    if (reply.useYn === 'N') throw new MaintenanceError(PROVIDER, 'KMTC\'s cargo search is closed for now');
    if (reply.useYn !== 'Y') throw new SchemaError(PROVIDER, 'KMTC returned an invalid search reply');
    return null;
  }
  const seen = new Map<string, KmtcContainer>();
  for (const row of rows) {
    const container = text(row, 'cntrNo', 20);
    const bill = text(row, 'blNo', 20);
    const booking = text(row, 'bkgNo', 100);
    const ours = query.kind === 'BL' ? bill === query.number : booking.split('<br>').includes(query.number);
    if (!ours) throw new SchemaError(PROVIDER, 'KMTC returned containers of another number');
    // A container shared by several bookings lists them apart with <br>; one not yet booked has none.
    if (!CONTAINER.test(container) || !/^[A-Z\d]{0,20}$/.test(bill) || !/^(?:[A-Z\d]{1,20}(?:<br>[A-Z\d]{1,20}){0,9})?$/.test(booking)) {
      throw new SchemaError(PROVIDER, 'KMTC returned an invalid container');
    }
    if (!seen.has(container)) seen.set(container, { container, bill, booking });
  }
  return [...seen.values()];
}

/** The page's request for a container's moves, under its bill, or its booking before the bill is issued. */
export function kmtcDetailUrl(query: KmtcQuery, { container, bill, booking }: KmtcContainer): string {
  const params = new URLSearchParams({ bkgNo: booking, cntrNo: container, dtKnd: query.kind, strBkgNo: booking });
  return `${KMTC_API}/cargo-tracking/${encodeURIComponent(bill || booking)}/detail?${params}`;
}

// KMTC gives a port's code and country. Its US ports keep the zone of their state.
const US_PORT_ZONES: Readonly<Record<string, string>> = { LGB: 'America/Los_Angeles', LAX: 'America/Los_Angeles' };

/** A move's wall clock, and the instant it gives when its country, or its US port, keeps one zone. */
function stamp(date: string, time: string, country: string, place: string) {
  const local = /^\d{8}$/.test(date) && /^\d{6}$/.test(time)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}` : '';
  const year = Number(local.slice(0, 4));
  if (!local || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'KMTC returned an invalid move time');
  const zone = country === 'US' ? US_PORT_ZONES[place] : countryTimeZone(country);
  const instant = zone ? isoTime(local, zone) : null;
  return instant ? { local_time: local, time: instant.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

type Move = CarrierEvent & { local_time: string };

/**
 * A container's moves from the page's detail request. Like the page, it sets aside the moves
 * before the container's latest pick up, which belong to its previous trip.
 */
export function kmtcMoves(reply: unknown, { bill }: KmtcContainer): Move[] {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'KMTC returned invalid moves');
  const rows = [...list(reply, 'trackingList'), ...list(reply, 'inlandListIn')];
  const moves = rows.map(row => {
    const moved = text(row, 'blNo', 20);
    if (bill && moved && moved !== bill) throw new SchemaError(PROVIDER, 'KMTC returned moves of another bill');
    const code = text(row, 'rkCode', 20);
    if (!/^[A-Z]{3,12}$/.test(code)) throw new SchemaError(PROVIDER, 'KMTC returned a move without its code');
    const country = text(row, 'ctrCd', 5);
    const location = [text(row, 'trmlNm'), text(row, 'plcNm')].filter(Boolean).join(', ');
    const stage = kmtcStage(code);
    const move: Move = { ...stamp(text(row, 'mvntDt', 8), text(row, 'mvntTm', 6), country, text(row, 'plcCd', 10)),
      ...(location ? { location } : {}), description: kmtcWording(code), provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
    return { move, pickUp: row.rk === 1 };
  });
  const start = moves.filter(({ pickUp }) => pickUp).map(({ move }) => move.local_time).sort().at(-1) ?? '';
  return moves.filter(({ move }) => move.local_time >= start).map(({ move }) => move);
}

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's moves newest first. A gate in after the container moved is transit; an empty
 * container returned before it moved was not used, which is no delivery.
 */
function containerHistory(moves: readonly Move[]): Move[] {
  const events = [...moves].sort(newestFirst);
  let moved = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'delivered' && !moved) {
      delete (event as CarrierEvent).stage;
      delete (event as CarrierEvent).stage_source;
    } else if (moved && event.stage && BEFORE_MOVING.has(event.stage)) {
      event.stage = 'in_transit';
    }
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return events;
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged move, or whose moves were not asked, leaves the stage open.
 */
function currentStage(histories: readonly Move[][]): Stage | undefined {
  const latest = histories.map(events => events.find(event => event.stage)).filter((event): event is Move => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

/** The shipment from its containers' moves, merged newest first and those the containers share kept once. */
export function kmtcResult(containers: readonly KmtcContainer[] | null, details: ReadonlyMap<string, readonly Move[]> = new Map()): CarrierResult {
  if (!containers) throw new NotFoundError(PROVIDER, 'KMTC does not hold this number');
  const histories = containers.map(({ container }) => containerHistory(details.get(container) ?? []));
  const truncated = containers.some(({ container }) => !details.has(container));
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'KMTC lists the shipment without moves', { reason: 'listed' });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null, ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null, ...(truncated || events.length > MAX_ROWS ? { history_truncated: true } : {}), events: events.slice(0, MAX_ROWS),
  };
}

const REFUSED = /<title>\s*Access Denied\s*<\/title>/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function kmtcJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (REFUSED.test(body)) throw new ChallengeError(PROVIDER, 'Akamai refused KMTC\'s tracking request');
    throw new SchemaError(PROVIDER, 'KMTC returned a page instead of JSON');
  }
}
