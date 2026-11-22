import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { furtherAlong } from '../../core/status/progress.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { courierItEventName } from '../courier-it/status.js';
import { postNetStage } from './status.js';

export const PROVIDER = 'PostNet';
export const POSTNET_ORIGIN = 'https://www.postnet.co.za';
/** The tracker page, which opens a session and carries the lookup's token. */
export const POSTNET_TRACKER = `${POSTNET_ORIGIN}/tracker`;
/** The lookup the tracker page makes for each of the networks PostNet sends parcels with. */
export const POSTNET_LOOKUP = `${POSTNET_ORIGIN}/postnet-track/exit/`;
// The page is about 66 kB; a waybill's events are about 150 bytes each.
export const POSTNET_MAX_BYTES = 512 * 1024;

/**
 * The networks the tracker page asks, in the order the adapter asks them:
 * Aramex carries PostNet's counter-to-counter waybills and Courier IT carried
 * the older ones, so they come first.
 */
export const POSTNET_NETWORKS = ['aramex', 'cit', 'dhl', 'sprint', 'coastal'] as const;
export type PostNetNetwork = (typeof POSTNET_NETWORKS)[number];

// South Africa keeps UTC+2 all year.
const ZONE = 'Africa/Johannesburg';
const MAX_EVENTS = 300;
const TOKEN = /^[0-9a-f]{32}$/;
// The counter-to-counter waybills: PN or PP and seven digits, then PNA and ten digits or PPA and eleven.
const WAYBILL = /^(?:P[NP]\d{7}|PNA\d{10}|PPA\d{11})$/;
const DAY = /^\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
const TIME = /^(?:0[1-9]|1[0-2]):[0-5]\d [AP]M$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|h-captcha/i;

/** PostNet's counter-to-counter waybills, which the tracker page asks for. */
export function normalizePostNetNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (WAYBILL.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'PostNet tracks PN and PP waybills');
}

/** The lookup's address for one network, as the tracker page builds it. */
export function postNetLookupUrl(number: string, network: PostNetNetwork, token: string): string {
  return `${POSTNET_LOOKUP}?${new URLSearchParams({ rawpost: '1', tracking_number: number, provider: network, t: token })}`;
}

/** Whether an answer is a block page instead of the tracker's own. */
export function isPostNetBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The token of the tracker page, which the lookups are made with. */
export function parsePostNetTracker(html: string): string {
  const token = load(html)('input#track-token').attr('value') ?? '';
  if (TOKEN.test(token)) return token;
  if (isPostNetBlocked(html)) throw new ChallengeError(PROVIDER, 'PostNet answered with a block page');
  throw new SchemaError(PROVIDER, 'PostNet changed its tracker page');
}

/** An event's instant, from its day and its time, on South Africa's clock. */
function instantOf(day: string, time: string): string {
  const wall = DAY.test(day) && TIME.test(time) ? DateTime.fromFormat(`${day} ${time}`, 'd LLLL yyyy hh:mm a', { locale: 'en', zone: 'utc' }) : null;
  const zoned = wall?.isValid ? firstOccurrence(DateTime.fromISO(wall.toISO({ includeOffset: false }), { zone: ZONE })) : null;
  if (!zoned?.isValid) throw new SchemaError(PROVIDER, 'PostNet returned an invalid event time');
  return zoned.toISO({ suppressMilliseconds: true });
}

function text(event: Record<string, unknown>, field: string, length: number): string {
  const value = event[field];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PostNet returned an event without ${field}`);
  return clean(value, length);
}

/**
 * One network's answer: its events for the waybill, newest first, or none
 * when the body is empty, which is how a network without the waybill answers.
 * Courier IT's events name a detail after their event, such as who signed or
 * which driver loaded the parcel, so only the event is kept.
 */
export function parsePostNetEvents(body: string, network: PostNetNetwork): CarrierEvent[] {
  if (!body.trim()) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (isPostNetBlocked(body)) throw new ChallengeError(PROVIDER, 'PostNet answered with a block page');
    throw new SchemaError(PROVIDER, 'PostNet returned an invalid answer');
  }
  if (!Array.isArray(payload) || !payload.length) throw new SchemaError(PROVIDER, 'PostNet returned an unexpected answer');
  if (payload.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'PostNet returned an oversized history');
  return payload.map((value: unknown): CarrierEvent => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(PROVIDER, 'PostNet returned an invalid event');
    const event = value as Record<string, unknown>;
    const said = text(event, 'description', 200);
    const description = network === 'cit' ? courierItEventName(said) : said;
    if (!description) throw new SchemaError(PROVIDER, 'PostNet returned an event without a description');
    const location = text(event, 'location', 80);
    const stage = postNetStage(description);
    return {
      time: instantOf(text(event, 'date', 30), text(event, 'time', 10)),
      ...(location ? { location } : {}),
      description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  // A Courier IT comment is only its staff's note, which the event leaves out.
  }).filter((event) => !(network === 'cit' && /^comment$/i.test(event.description!)));
}

/**
 * The waybill's result from the events of the network that holds it. The
 * answer does not repeat the waybill; the lookup names the whole of it.
 */
export function postNetResult(events: CarrierEvent[]): CarrierResult {
  // The tracker lists events newest first; events of one minute keep its order.
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => Date.parse(right.event.time!) - Date.parse(left.event.time!) || left.index - right.index)
    .map(({ event }) => event);
  const staged = ordered.filter((event) => event.stage);
  // Courier IT captures a waybill's details after it takes the parcel, which does not set it back.
  const stage = (staged[0]?.stage === 'registered' ? staged.find((event) => furtherAlong('registered', event.stage)) ?? staged[0]
    : staged[0])?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: ordered[0]!.description!,
    last_update: ordered[0]!.time!,
    expected_delivery: null,
    events: ordered,
  };
}
