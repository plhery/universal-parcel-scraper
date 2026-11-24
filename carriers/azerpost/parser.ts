import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, EXPLICIT_OFFSET_PATTERN, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { azerpostStage, statusMap } from './status.js';

export const PROVIDER = 'Azerpost';
export const AZERPOST_ORIGIN = 'https://www.azerpost.az';
/** The tracking page, in English, whose script posts the number. */
export const AZERPOST_PAGE = `${AZERPOST_ORIGIN}/en/services/tracking-of-shipments`;
/** Where the page's script posts the number, with the language of the event names last. */
export const AZERPOST_LOOKUP = `${AZERPOST_ORIGIN}/api/get-package/en`;
// A reply with three scans is about 500 bytes; a scan adds about 120.
export const AZERPOST_MAX_BYTES = 256 * 1024;

const MAX_SCANS = 300;
const NOT_FOUND = 'Tracking number not found';
// The address of the backend lookup a not-found reply names, which ends with the number asked.
const LOOKED_UP = /\/Tracking\/([^/?#]{1,64})\/?(?:[?#].*)?$/i;
// A scan's date and time on its office's clock, the seconds with up to seven decimals: "2025-03-10T06:37:10.566667".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
// Who took a delivered item, as the former tracker followed its delivery with it ("Çatdırılıb, alıcı: …"): dropped.
const RECIPIENT = /\s*[,;]?\s*(?:recipient|receiver|addressee|consignee|signatory|signed by|received by|alıcı|получатель|адресат)\s*:.*$/isu;
// An office as IPS names it, its town or country before its code: "Bakı: AZ1000", "TURKEY: TRISTE".
const OFFICE = /^([^:]{1,80}?)\s*:\s*([A-Z0-9]{2,12})$/u;
// A firewall's or bot check's page in place of the reply, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|requested URL was rejected|support ID is|_cf_chl_opt|cf-turnstile|g-recaptcha/i;

/**
 * The tracker looks items up in the postal union's IPS by their UPU S10 code: Azerpost's own,
 * ending in AZ, and items from abroad. The page takes thirteen characters; the adapter also
 * checks the check digit.
 */
export function normalizeAzerpostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Azerpost tracks S10 item codes');
}

/** Whether a reply is a block page instead of the tracker's. */
export function isAzerpostBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A scan's clock: a stated offset is kept, a wall clock stays one, on the office's clock wherever it is. */
function clockOf(value: unknown): { time: string } | { local_time: string } {
  const text = clean(value, 40);
  if (EXPLICIT_OFFSET_PATTERN.test(text)) return { time: explicitOffsetTime(text)?.iso ?? invalid('Azerpost returned an invalid scan time') };
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) return invalid('Azerpost returned an invalid scan time');
  return { local_time: `${day}T${match[4]}:${match[5]}:${match[6] ?? '00'}` };
}

/** A scan's wording without who took the item; a delivery keeps its event's name alone. */
function wordingOf(raw: string): string {
  const text = raw.replace(RECIPIENT, '').trim();
  const head = text.split(/\s*[,;:([]\s*|\s+-\s+/)[0]!.trim();
  return head !== text && azerpostStage(head)?.stage === 'delivered' ? head : text;
}

/**
 * A scan's office, its code first: "AZ1000, Bakı" is Baku's post office, where "Bakı: AZ1000"
 * also reads as Bakı in Indonesia, and "TRISTE, TURKEY" is Istanbul's office of exchange, which
 * dates the scan on the office's clock rather than the destination's.
 */
function officeOf(value: unknown): string {
  const text = clean(value, 120);
  const match = OFFICE.exec(text);
  return match ? `${match[2]}, ${match[1]}` : text;
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('Azerpost returned an invalid scan');
  const wording = wordingOf(clean(row.Code, 200));
  if (!wording) return invalid('Azerpost returned a scan without its event');
  const location = officeOf(row.OfficeCd);
  const staged = azerpostStage(wording);
  return {
    ...clockOf(row.Date),
    ...(location ? { location } : {}),
    description: wording,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * A reply without the item. The tracker's not-found names the backend lookup it made, which ends
 * with the number; without that address it still answers the one stateless request that posted
 * it. A refused field, an error code or anything else is never a missing item.
 */
function unanswered(payload: Record<string, unknown>, number: string): never {
  if (payload.code === 404 && payload.desc === NOT_FOUND) {
    if (payload.data === undefined) throw new NotFoundError(PROVIDER);
    const asked = typeof payload.data === 'string' ? LOOKED_UP.exec(payload.data)?.[1] : undefined;
    let named: string | null;
    try {
      named = asked ? normalizeTrackingNumber(decodeURIComponent(asked)) : null;
    } catch {
      named = null;
    }
    if (named === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Azerpost answered not found for another lookup');
  }
  if (payload.error === true && isRecord(payload.errors)) {
    // The page's reCAPTCHA and session tokens, which the tracker does not ask for now.
    if (Object.keys(payload.errors).some((field) => field === 'g_token' || field === '_token')) {
      throw new ChallengeError(PROVIDER, "Azerpost refused the lookup without the page's tokens");
    }
    return invalid('Azerpost refused the fields the page posts');
  }
  if (payload.code === 429) throw new RateLimitedError(PROVIDER);
  if (typeof payload.code === 'number' && payload.code >= 500) throw new IndeterminateError(PROVIDER, "Azerpost's tracking service failed");
  return invalid('Azerpost returned an unexpected reply');
}

/**
 * The tracker's answer for one number: IPS's record of the item, in English. It names the item,
 * its weight in kilograms, mail class, contents, origin and destination countries, a postal
 * status, and its scans, oldest first, each with an event name, a wall clock and the office.
 * The adapter keeps the scans newest first, the weight and the destination. The mail class, the
 * contents, the origin and the postal status, which does not follow the scans, are not read.
 */
export function parseAzerpost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeAzerpostNumber(rawNumber);
  if (!isRecord(payload)) return invalid('Azerpost returned an unreadable reply');
  if (payload.Item === undefined) unanswered(payload, number);
  const item = payload.Item;
  if (!isRecord(item)) return invalid('Azerpost returned an invalid item');
  const identifier = clean(item['@Identifier'], 64);
  if (!identifier) return invalid('Azerpost returned an item without its code');
  if (normalizeTrackingNumber(identifier) !== number) throw new IndeterminateError(PROVIDER, 'Azerpost answered for another item');
  // One scan can come as an object rather than a list of one.
  const rows = item.Event === undefined || item.Event === null ? [] : Array.isArray(item.Event) ? item.Event : [item.Event];
  if (rows.length > MAX_SCANS) return invalid('Azerpost returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Azerpost lists the item without a scan', { reason: 'listed' });
  // IPS lists the scans oldest first; their wall clocks are on different offices' clocks.
  const events = rows.map(scanOf).reverse();
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  const weight = typeof item.Weight === 'number' && Number.isFinite(item.Weight) && item.Weight > 0 && item.Weight < 1000 ? item.Weight : null;
  const destinationName = clean(item.DestCountryCd, 80);
  const destination = destinationName ? countryCode(destinationName) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : destinationName ? { destination_country_name: destinationName } : {}),
    events,
  };
}
