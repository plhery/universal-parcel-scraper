import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { neighbourStage } from './status.js';

export const PROVIDER = 'Neighbour Express';
export const NEIGHBOUR_ORIGIN = 'https://neighbourexpress.com';
export const NEIGHBOUR_MAX_BYTES = 500000;

/**
 * The tracking page's own split: a reference beginning with NR, or N with R as its sixth character,
 * is a return label read through the verified route; any other reference goes to the shipment route.
 */
export const isNeighbourReturn = (number: string): boolean => /^(?:NR|N[A-Z0-9]{4}R)/.test(number);

export function normalizeNeighbourNumber(raw: string): string {
  const number = raw.length <= 50 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{6,40}$/.test(number) || /^N[A-Z0-9]{4}R$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Neighbour Express tracking takes a whole shipment or return reference');
  }
  return number;
}
export const neighbourPageUrl = (number: string): string => `${NEIGHBOUR_ORIGIN}/track?${new URLSearchParams({ no: number })}`;
export const neighbourLookupUrl = (number: string): string => `${NEIGHBOUR_ORIGIN}/api/basic/zt/api/website/batchTrackByTrackno?${new URLSearchParams({ tracknos: number })}`;
/** The shipment route the page posts every other reference to, with the postcode field it leaves empty. */
export const NEIGHBOUR_SHIPMENT_URL = `${NEIGHBOUR_ORIGIN}/api/basic/zt/api/jy/tracks`;

/** This is the native client signal to ask for AJ verification, not a missing parcel. */
export const neighbourNeedsVerification = (data: unknown): boolean => isRecord(data) && (data.code === '1' || data.code === 1) && data.data === 0;

export function parseNeighbour(data: unknown, raw: string): CarrierResult {
  const number = normalizeNeighbourNumber(raw);
  if (neighbourNeedsVerification(data)) throw new ChallengeError(PROVIDER, 'Neighbour Express requires guest verification', { reason: 'guest_verification_required' });
  if (!isRecord(data) || data.code !== '0' && data.code !== 0 || !isRecord(data.data) || !Array.isArray(data.data.results)) {
    throw new SchemaError(PROVIDER, 'Neighbour Express changed its guest tracking reply');
  }
  const results: unknown[] = data.data.results;
  if (results.length === 0) throw new IndeterminateError(PROVIDER, 'Neighbour Express returned no bound history');
  if (results.length !== 1 || !isRecord(results[0]) || results[0].trackno !== number) {
    throw new SchemaError(PROVIDER, 'Neighbour Express did not identify one whole return label');
  }
  const result = results[0];
  if (result.status !== 'success') throw new IndeterminateError(PROVIDER, 'Neighbour Express did not confirm a return history');
  if (!Array.isArray(result.data)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its event list');
  if (!result.data.length) throw new IndeterminateError(PROVIDER, 'Neighbour Express returned no dated scans');
  if (result.data.length > 300) throw new SchemaError(PROVIDER, 'Neighbour Express returned too many events');
  const events: CarrierEvent[] = result.data.map((row: unknown) => {
    if (!isRecord(row) || typeof row.statusText !== 'string' || !row.statusText.trim() || row.statusText.length > 300
      || !['string', 'number'].includes(typeof row.status) || !/^\d{1,8}$/.test(String(row.status))
      || typeof row.time !== 'string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.time)
      || typeof row.timezone !== 'string' || !/^UTC[+-](?:0\d|1[0-4]):[0-5]\d$/.test(row.timezone)
      || /^UTC[+-]14:(?!00)/.test(row.timezone)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its scan fields');
    const local = row.time.replace(' ', 'T'), clock = explicitOffsetTime(local + row.timezone.slice(3));
    if (!clock) throw new SchemaError(PROVIDER, 'Neighbour Express returned an invalid scan clock');
    const description = clean(row.statusText, 300), code = String(row.status), stage = neighbourStage(code, description);
    return { time: clock.iso, local_time: local, time_zone: row.timezone, time_zone_basis: 'carrier',
      description, provider_code: code, ...(stage ? { stage, stage_source: 'explicit_mapping' } : {}) };
  }).reverse().sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const latest = events[0]!, stage = neighbourStage(latest.provider_code!, latest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage ?? 'unknown',
    current_stage_source: stage ? 'explicit_mapping' : 'none', last_status_text: latest.description!,
    last_update: latest.time!, last_update_local: latest.local_time!, timezone: latest.time_zone!, expected_delivery: null,
    canonical_tracking_number: number, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(stage === 'delivered' ? { delivered_at: latest.time! } : {}) };
}

const SHIPMENT_TIME = /^(20\d{2}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?([+-](?:0\d|1[0-4]):[0-5]\d)?$/;
const SHIPMENT_ZONE = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/;

/** The page's zone forms, UTC-5, UTC-05:00 or UTC+8:00, as an offset such as -05:00; null when malformed. */
function shipmentOffset(zone: string): string | null {
  const match = SHIPMENT_ZONE.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]), minutes = Number(match[3] ?? 0);
  if (hours > 14 || hours === 14 && minutes > 0) return null;
  return `${match[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** The page's region path, such as Canada/ON/Vaughan, read from the city up. */
const shipmentPlace = (city: unknown): string | undefined => {
  const parts = clean(city, 160).split('/').map(part => part.trim()).filter(Boolean);
  return parts.length ? parts.reverse().join(', ') : undefined;
};

/** The shipment route's reply: its explicit not-found codes, then exactly one package with the whole reference. */
export function parseNeighbourShipment(data: unknown, raw: string): CarrierResult {
  const number = normalizeNeighbourNumber(raw);
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its shipment tracking reply');
  const code = cleanScalar(data.code, 20);
  // The page names 500301 ORDER_NOT_FOUND and 401002 UNAUTHORIZED; code 1 asks to try again later.
  if (code === '500301') throw new NotFoundError(PROVIDER, 'Neighbour Express has no shipment under this reference');
  if (code === '401002') throw new ChallengeError(PROVIDER, 'Neighbour Express refused the guest shipment lookup', { reason: 'unauthorized' });
  if (code === '1') throw new MaintenanceError(PROVIDER, 'Neighbour Express could not query its shipment tracks');
  if (code !== '0' || !Array.isArray(data.data)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its shipment tracking reply');
  const packages: unknown[] = data.data;
  if (packages.length === 0) throw new NotFoundError(PROVIDER, 'Neighbour Express has no shipment under this reference');
  const found = packages[0];
  if (packages.length !== 1 || !isRecord(found) || found.pkgNo !== number && found.subOrderNo !== number) {
    throw new SchemaError(PROVIDER, 'Neighbour Express did not identify one whole shipment');
  }
  if (!Array.isArray(found.track) || found.track.length > 300) throw new SchemaError(PROVIDER, 'Neighbour Express changed its shipment scans');
  if (!found.track.length) throw new NoHistoryError(PROVIDER, 'Neighbour Express lists the shipment without scans', { reason: 'listed' });
  const events: CarrierEvent[] = found.track.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its shipment scans');
    const rowCode = cleanScalar(row.code, 20), description = clean(row.content, 300);
    const time = typeof row.time === 'string' ? SHIPMENT_TIME.exec(row.time) : null;
    const zone = typeof row.timezone === 'string' && row.timezone.trim() ? shipmentOffset(row.timezone.trim()) : undefined;
    if (!/^\d{1,8}$/.test(rowCode) || !description || typeof row.content === 'string' && row.content.length > 300 || !time || zone === null
      || zone && time[3] && zone !== time[3]) throw new SchemaError(PROVIDER, 'Neighbour Express changed its shipment scan fields');
    // The page reads the wall clock in the row's stated zone; without one the clock's own offset must say it.
    const offset = zone ?? time[3];
    if (!offset) throw new SchemaError(PROVIDER, 'Neighbour Express returned a shipment scan without its zone');
    const local = `${time[1]}T${time[2]}`, clock = explicitOffsetTime(local + offset);
    if (!clock) throw new SchemaError(PROVIDER, 'Neighbour Express returned an invalid shipment scan clock');
    const mapped = neighbourStage(rowCode, description), worded = mapped ? null : classifyWording(description);
    const stage: { stage: Stage; source: string } | undefined = mapped ? { stage: mapped, source: 'explicit_mapping' }
      : worded && worded.source !== 'none' ? worded : undefined;
    const location = shipmentPlace(row.city);
    return { time: clock.iso, local_time: local, time_zone: `UTC${offset}`, time_zone_basis: 'carrier', description,
      provider_code: rowCode, ...(location ? { location } : {}), ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  }).reverse().sort((left: CarrierEvent, right: CarrierEvent) => Date.parse(right.time!) - Date.parse(left.time!));
  const latest = events[0]!, stage = latest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage ?? 'unknown',
    current_stage_source: latest.stage_source ?? 'none', last_status_text: latest.description!,
    last_update: latest.time!, last_update_local: latest.local_time!, timezone: latest.time_zone!, expected_delivery: null,
    canonical_tracking_number: number, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(stage === 'delivered' ? { delivered_at: latest.time! } : {}) };
}
