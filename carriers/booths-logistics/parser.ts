import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { boothsStage } from './status.js';

export const PROVIDER = 'booths-logistics';
// A search lists a few consignments; a consignment with its events is a few kilobytes.
export const BOOTHS_MAX_BYTES = 512 * 1024;

// A consignment number: the letters and digits Booth's system gives a job ("100067364") or the customer's own.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,30}$/;
// "2024-10-15T14:35:35": a wall clock, sometimes with a fraction of a second.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?$/;
const CODE = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const MAX_HITS = 100;
const MAX_EVENTS = 300;
// Booth's runs its depots in New Zealand, whose events state their UTC time beside the wall clock.
const ZONE = 'Pacific/Auckland';

/** A number for Booth's tracker, as its search box takes it: letters and digits, without spaces or dashes. */
export function normalizeBoothsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Booth\'s consignment number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const empty = (value: unknown) => value === null || value === undefined;

function text(value: unknown, max: number): string | undefined {
  if (empty(value)) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('Booth\'s tracker returned an invalid field');
  return clean(value, max) || undefined;
}

/** The reply's `data` once it says it succeeded; a refusal is the service's error, never a missing consignment. */
function dataOf(payload: unknown): unknown {
  if (!isRecord(payload) || typeof payload.success !== 'boolean') return invalid('Booth\'s tracker returned an unreadable reply');
  if (!payload.success || payload.failed === true) {
    throw new TransportError(PROVIDER, `Booth's tracker answered with an error${typeof payload.message === 'string' ? `: ${clean(payload.message, 120)}` : ''}`);
  }
  return payload.data;
}

export interface BoothsHit { id: number; containerId: number | null }

/**
 * The consignment a `ReferenceSearch` reply lists under the number. The search also takes a
 * customer's pickup, order or delivery reference and lists every consignment under it; only a
 * consignment whose own number is the one asked answers it. An empty list is not found.
 */
export function boothsHit(payload: unknown, number: string): BoothsHit {
  const data = dataOf(payload);
  if (!Array.isArray(data) || data.length > MAX_HITS) return invalid('Booth\'s tracker returned an invalid search');
  if (data.length === 0) throw new NotFoundError(PROVIDER, 'Booth\'s has no consignment under this number');
  const hits = data.map((hit) => {
    if (!isRecord(hit) || !Number.isSafeInteger(hit.id) || (hit.id as number) <= 0
      || !(empty(hit.containerID) || (Number.isSafeInteger(hit.containerID) && (hit.containerID as number) > 0))) {
      return invalid('Booth\'s tracker returned an invalid search result');
    }
    return { id: hit.id as number, containerId: (hit.containerID as number | null | undefined) ?? null,
      reference: normalizeTrackingNumber(text(hit.reference, 64) ?? '') };
  }).filter((hit) => hit.reference === number);
  if (hits.length === 0) throw new IndeterminateError(PROVIDER, 'Booth\'s lists consignments under another number for this reference');
  if (new Set(hits.map((hit) => hit.id)).size > 1) throw new IndeterminateError(PROVIDER, 'Booth\'s lists several consignments under this number');
  return { id: hits[0]!.id, containerId: hits[0]!.containerId };
}

/** A wall clock, calendar-checked, to the second, and its reading as if it were UTC. */
function clockOf(value: unknown): { wall: string; asUtc: number } | undefined {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) return undefined;
  const wall = `${day}T${match[4]}:${match[5]}:${match[6]}`;
  return { wall, asUtc: Date.parse(`${wall}Z`) };
}

function offsetText(minutes: number): string {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/**
 * The offset an event states: its `eventDateUtc` read against its `eventDate`, when the two are
 * the offset New Zealand's clocks kept at that instant. Otherwise the event keeps its wall clock.
 */
function statedOffset(asUtc: number, utc: unknown): string | undefined {
  if (empty(utc)) return undefined;
  const instant = clockOf(utc) ?? invalid('Booth\'s tracker returned an invalid UTC time');
  const minutes = (asUtc - instant.asUtc) / 60_000;
  return DateTime.fromMillis(instant.asUtc, { zone: ZONE }).offset === minutes ? offsetText(minutes) : undefined;
}

interface Read { event: CarrierEvent; at: number; code: string; location: string }

function eventOf(value: unknown): Read | undefined {
  if (!isRecord(value) || typeof value.milestone !== 'boolean') return invalid('Booth\'s tracker returned an invalid event');
  const code = text(value.eventCode, 40);
  if (!code || !CODE.test(code)) return invalid('Booth\'s tracker returned an invalid event code');
  const description = text(value.milestoneName, 80) ?? text(value.eventName, 80) ?? code;
  const clock = clockOf(value.eventDate) ?? invalid('Booth\'s tracker returned an invalid event time');
  // The tracker's history shows milestones alone; the other events are the system's own steps.
  if (!value.milestone) return undefined;
  const places = value.locations;
  if (!empty(places) && !Array.isArray(places)) return invalid('Booth\'s tracker returned invalid event locations');
  const first: unknown = Array.isArray(places) ? places[0] : undefined;
  if (first !== undefined && !isRecord(first)) return invalid('Booth\'s tracker returned an invalid event location');
  const location = text(first?.locationName, 120) ?? text(value.locationName, 120) ?? '';
  const offset = statedOffset(clock.asUtc, value.eventDateUtc);
  const stage = boothsStage(code, description);
  return {
    event: {
      ...(offset ? { time: `${clock.wall}${offset}` } : { local_time: clock.wall }),
      description,
      ...(location ? { location } : {}),
      provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    },
    at: clock.asUtc, code, location,
  };
}

/**
 * A `ConsignmentTrack/{id}` reply: the consignment's milestones newest first, each once per place
 * as the tracker shows them, and its status. Addresses, contacts, weights and the container's
 * details stay behind.
 */
export function parseBooths(payload: unknown, number: string): CarrierResult {
  const data = dataOf(payload);
  if (!isRecord(data)) return invalid('Booth\'s tracker returned no consignment');
  const reference = text(data.reference, 64) ?? invalid('Booth\'s tracker returned a consignment without its number');
  if (normalizeTrackingNumber(reference) !== number) {
    throw new IndeterminateError(PROVIDER, 'Booth\'s tracker answered for another consignment');
  }
  const status = text(data.status, 60);
  if (!Array.isArray(data.events) || data.events.length > MAX_EVENTS) return invalid('Booth\'s tracker returned invalid events');
  // The tracker keeps the newest event of each code at each place.
  const newest = new Map<string, Read>();
  for (const read of data.events.map(eventOf)) {
    if (!read) continue;
    const key = `${read.code}~${read.location}`;
    const kept = newest.get(key);
    if (!kept || read.at > kept.at) newest.set(key, read);
  }
  const events = [...newest.values()].sort((a, b) => b.at - a.at).map((read) => read.event);
  if (!status && events.length === 0) return invalid('Booth\'s tracker returned a consignment without a status or events');

  const latest = events[0];
  const stage = (status ? boothsStage(null, status) : undefined) ?? (events.find((event) => event.stage)?.stage as Stage | undefined);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: status ?? latest?.description ?? null,
    last_update: latest?.time ?? null,
    ...(latest?.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && latest?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
