import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { e24Stage, statusMap } from './status.js';

export const PROVIDER = 'E24';
export const CARRIER = 'e24metro-ca';
// A search reply is about 1.5 kB and a delivered parcel's statuses about 4 kB.
export const E24_MAX_BYTES = 256 * 1024;

// "363C38-8B1AA496": six and eight hexadecimal digits, in capitals; the tracker finds nothing for another form.
const HEX = /^[0-9A-F]{14}$/;
// The tracker's page for one parcel, its query an opaque token.
const LINK = /^https:\/\/tracking-ca\.fareye\.co\/universal-tracking\?([A-Za-z0-9+/]{20,400}={0,2})#\/$/;
// "2026-08-04 18:28:57".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// A firewall's, CDN's or bot check's page in place of the tracker's reply.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|The request is blocked|awswaf/i;
/** The search's whole reply for a number it holds no parcel for. */
export const E24_NOT_FOUND = 'NO URL FOUND';
const MAX_ROWS = 500;

/** A number for E24's tracker: fourteen hexadecimal digits, written in capitals with a dash after the sixth. */
export function normalizeE24Number(raw: string): string {
  const digits = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!HEX.test(digits)) throw new InvalidInputError(PROVIDER, 'E24 numbers are six and eight hexadecimal digits');
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/** Whether a reply is a block page instead of the tracker's. */
export function isE24Blocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * The token of the parcel's page in the reply of `get_universal_tracking_url`, the search E24's tracking page
 * makes: a bracketed list of the page in each language the tracker offers, the first of which the page opens,
 * or `NO URL FOUND`.
 */
export function e24Token(body: string): string {
  const reply = body.replace(/^\uFEFF/, '').trim();
  if (reply === E24_NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (isE24Blocked(reply)) throw new ChallengeError(PROVIDER, 'E24 answered with a browser check');
  if (!reply.startsWith('[') || !reply.endsWith(']')) return invalid('E24 returned an unexpected search reply');
  const first = reply.slice(1, -1).split(',')[0]!.trim();
  return LINK.exec(first)?.[1] ?? invalid('E24 returned a search reply without a tracking page');
}

/** A UTC clock as the reply writes it, or null; date libraries accept hour 24, so the hour is checked here. */
function utc(value: unknown): DateTime | null {
  const parts = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!parts || Number(parts[1]) < 2000 || Number(parts[4]) > 23) return null;
  const parsed = DateTime.fromFormat(parts[0], 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
  return parsed.isValid ? parsed : null;
}

interface Row {
  reference: string;
  event: CarrierEvent;
  at: number;
  index: number;
}

/**
 * One status as the reply writes it: the number, the wording and the clock in UTC (`statusClientTime`, which
 * the page shows with " UTC"). The clock of E24's zone beside it (`statusTime`) and the remarks are not read.
 */
function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) return invalid('E24 returned an invalid status');
  if (typeof value.referenceNumber !== 'string') return invalid('E24 returned a status without its number');
  if (typeof value.status !== 'string' || value.status.length > 500) return invalid('E24 returned a status without its wording');
  const description = clean(value.status, 300);
  if (!description) return invalid('E24 returned a status without its wording');
  const instant = utc(value.statusClientTime) ?? invalid('E24 returned a status without its time');
  const stage = e24Stage(normalizeStatusWording(description));
  return {
    reference: normalizeTrackingNumber(value.referenceNumber).toUpperCase(),
    at: instant.toMillis(),
    index,
    event: {
      time: instant.toISO({ suppressMilliseconds: true })!,
      description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    },
  };
}

/** The statuses of the parcel's delivery, as the page picks them: the list of the job it tracks. */
function statusesOf(payload: Record<string, unknown>): unknown[] {
  const domains = payload.processStatusLogDomainList;
  if (domains === undefined || domains === null) return [];
  if (!Array.isArray(domains)) return invalid('E24 returned invalid statuses');
  const job = payload.eventProcessMasterId;
  return domains.flatMap((domain) => {
    if (!isRecord(domain) || !Array.isArray(domain.processStatusLogDto)) return invalid('E24 returned invalid statuses');
    const logs = domain.processStatusLogDto as unknown[];
    const first = logs[0];
    return typeof job === 'number' && isRecord(first) && typeof first.processMasterId === 'number' && first.processMasterId !== job ? [] : logs;
  });
}

/**
 * E24's parcel as FarEye's tracking page reads it, from `get_last_mile_and_status_details`: the statuses of its
 * delivery, each with the number, its wording and its clock in UTC. The statuses keep the reply's UTC clock, to
 * the second.
 *
 * The feedback block, with its delivery photos, the remarks and the internal ids are never read.
 */
export function parseE24(payload: unknown, raw: string): CarrierResult {
  const number = normalizeE24Number(raw);
  if (!isRecord(payload)) return invalid('E24 returned an unexpected reply');
  const logs = statusesOf(payload);
  if (logs.length > MAX_ROWS) return invalid('E24 returned too many statuses');
  const rows = logs.map(rowOf);
  // Every status repeats the number; the search could only lead here for it.
  const asked = number.replace('-', '');
  if (rows.some((row) => row.reference !== asked)) throw new IndeterminateError(PROVIDER, 'E24 answered for another parcel');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const events = rows.sort((a, b) => b.at - a.at || b.index - a.index).map(({ event }) => event);
  const newest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function e24Json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isE24Blocked(body)) throw new ChallengeError(PROVIDER, 'E24 answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'E24 returned a reply that is not JSON', { cause });
  }
}
