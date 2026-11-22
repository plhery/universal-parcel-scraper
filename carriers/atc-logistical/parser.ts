import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { atcStage, atcStatusText } from './status.js';

export const PROVIDER = 'atc-logistical';
/** The lookup the Track Shipment form on atcsure.com sends a number to; it answers the address of that number's page. */
export const ATC_LOOKUP = 'https://atcsure.com/proxy.php';
// The page the lookup names: its `gc` is a token the lookup builds from the number, not the number itself.
const TRACKING_PAGE = /^https:\/\/www\.atcsure\.com\/tracking\.php\?gc=[A-Za-z0-9]{1,64}$/;
const UNKNOWN = /^Invalid LR No\.?$/i;
// A consignment note (LR, or bilty) number: letters and digits, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,20}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|captcha/i;
// The page's script carries the tracker's reply as a JSON string literal.
const REPLY = /^var responsetext = '(.*)';\s*$/m;
// "2023-07-03 00:00:00.000": a milestone's wall clock; the tracker writes midnight for a date alone.
const STAMP = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?$/;
// "04 Jul 2023": the date of a manifest or of its unloading.
const DAY = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_MANIFESTS = 100;

/** A consignment note number for ATC's tracker, as its form takes it. */
export function normalizeAtcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the LR number on the ATC consignment note');
  return number;
}

/** The lookup's address for one number, as the form's script builds it. */
export const atcLookupUrl = (number: string): string =>
  `${ATC_LOOKUP}?action=trackntrace_website&jsonreq=${encodeURIComponent(JSON.stringify({ GC_No: number }))}`;

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Whether a page is a browser check rather than one of the tracker's answers. */
export const isAtcChallenge = (body: string): boolean => CHALLENGE.test(body.slice(0, 64_000));

/**
 * The lookup's reply: the address of the number's tracking page, or "Invalid LR No." for a
 * number ATC has no consignment under.
 */
export function atcPageUrl(payload: unknown): string {
  if (!isRecord(payload) || payload.Status !== '1' || !Array.isArray(payload.Result) || payload.Result.length !== 1) {
    return invalid('ATC returned an unreadable lookup reply');
  }
  const [answer] = payload.Result as unknown[];
  const url = isRecord(answer) && typeof answer.Url === 'string' ? answer.Url.trim() : '';
  if (UNKNOWN.test(url)) throw new NotFoundError(PROVIDER, 'ATC has no consignment under this LR number');
  if (!TRACKING_PAGE.test(url)) return invalid('ATC named an unexpected tracking page');
  return url;
}

const text = (value: unknown, max = 80): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function stampOf(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parts = typeof value === 'string' ? STAMP.exec(value) : null;
  const date = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !date || Number(parts[1]) < 2001) return invalid('ATC returned an invalid date');
  return parts[4] === '00' && parts[5] === '00' && parts[6] === '00' ? date : `${date}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

function dayOf(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parts = typeof value === 'string' ? DAY.exec(value) : null;
  const date = parts ? calendarDay(Number(parts[3]), MONTHS.indexOf(parts[2]!) + 1, Number(parts[1])) : null;
  if (!parts || !date || Number(parts[3]) < 2001) return invalid('ATC returned an invalid manifest date');
  return date;
}

interface Dated { event: CarrierEvent & { local_time: string }; order: number }

function eventOf(local_time: string, code: string, description: string, location: string, order: number): Dated {
  const stage = atcStage(code);
  return { order, event: { local_time, description, provider_code: code, ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
}

/**
 * The tracking page for one number: the tracker's reply, which the page's script reads, holding
 * the consignment's milestones and the manifests it travelled on. The reply must name the whole
 * number asked. Names, phone numbers, addresses, the invoice, charges and vehicles stay behind;
 * dates keep the tracker's wall clock, as it gives no zone.
 */
export function parseAtcPage(html: string, number: string): CarrierResult {
  if (typeof html !== 'string' || !html) return invalid('ATC returned an empty page');
  const literal = REPLY.exec(html)?.[1];
  if (literal === undefined) {
    if (isAtcChallenge(html)) throw new ChallengeError(PROVIDER, 'ATC answered with a browser check');
    return invalid('ATC returned a page without its tracking reply');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(literal);
  } catch (error) {
    // The page carries the tracker's error message in place of its reply when the tracker fails.
    throw new SchemaError(PROVIDER, 'ATC returned a tracking reply that is not JSON', { cause: error });
  }
  if (!isRecord(reply) || typeof reply.Status !== 'string') return invalid('ATC returned an unreadable tracking reply');
  // The lookup named this page for the number, so a page that finds nothing is no answer about it.
  if (reply.Status !== '1') throw new IndeterminateError(PROVIDER, 'ATC’s tracking page found no consignment for the address its lookup gave');
  const result = isRecord(reply.Result) ? reply.Result : undefined;
  const rows = Array.isArray(result?.general_details) ? result.general_details : [];
  const general = rows.length === 1 && isRecord(rows[0]) ? rows[0] : undefined;
  if (!general) return invalid('ATC returned an invalid consignment');
  if (normalizeTrackingNumber(text(general.GC_No, 40)) !== number) throw new IndeterminateError(PROVIDER, 'ATC answered for another consignment');
  const manifests = result?.crossing_details ?? [];
  if (!Array.isArray(manifests) || manifests.length > MAX_MANIFESTS || !manifests.every(isRecord)) return invalid('ATC returned invalid manifests');

  const code = text(general.CurrentStatus, 40).toUpperCase();
  if (!code) return invalid('ATC returned a consignment without a status');
  const booking = text(general.BkgBranch), delivery = text(general.DlyBranch);
  const reached = stampOf(general.InwardDate);
  const dated: Dated[] = [];
  const booked = stampOf(general.GC_Date);
  if (booked) dated.push(eventOf(booked, 'BOOKED', atcStatusText('BOOKED')!, booking, 0));
  // Each manifest is a leg from one branch or hub to the next, and its unloading the leg's arrival.
  for (const [index, manifest] of manifests.entries()) {
    const from = text(manifest['Manifest From']), to = text(manifest['Manifest To']);
    const left = dayOf(manifest['Memo Date']);
    if (left) dated.push(eventOf(left, 'OUTWARD', to ? `Dispatched to ${to}` : 'Dispatched', from, 1 + index * 2));
    const arrived = dayOf(manifest['AUS/DDC Date']);
    const at = text(manifest['Unloaded/Deliverd At']) || to;
    // The last leg's unloading at the delivery branch is the milestone the consignment records for it.
    const milestone = reached !== undefined && arrived === reached.slice(0, 10) && at.toUpperCase() === delivery.toUpperCase();
    if (arrived && !milestone) dated.push(eventOf(arrived, 'AUS', 'Unloaded', at, 2 + index * 2));
  }
  // The consignment's own dispatch date is its latest manifest's, so it stands alone only without them.
  const dispatched = manifests.length ? undefined : stampOf(general.DispachDate);
  if (dispatched) dated.push(eventOf(dispatched, 'DISPATCHED', atcStatusText('DISPATCHED')!, booking, 1));
  const last = 1 + manifests.length * 2;
  for (const [at, milestone, offset] of [[reached, 'AT DELIVERY BRANCH', 1], [stampOf(general.PDSDate), 'LEFT FOR DELIVERY', 2],
    [stampOf(general.DlyDate), 'DELIVERED', 3]] as const) {
    if (at) dated.push(eventOf(at, milestone, atcStatusText(milestone)!, delivery, last + offset));
  }
  // Newest first; a day the tracker dates alike keeps the order the consignment went through it.
  const events = dated.sort((a, b) => b.event.local_time.slice(0, 10).localeCompare(a.event.local_time.slice(0, 10)) || b.order - a.order)
    .map(({ event }) => event);

  const stage: Stage | undefined = atcStage(code);
  const route = text(general.InTransitDetails);
  const wording = atcStatusText(code) ?? code;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: code,
    last_status_text: code === 'DISPATCHED' && route ? `${wording} (${route})` : wording,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
