import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { fliwayItemStage, fliwayMilestoneStage, fliwayMilestoneText, statusMap } from './status.js';

export const PROVIDER = 'fliway';
/**
 * Every clock in the reply is New Zealand's: Fliway works in New Zealand only, its rows give no zone,
 * and the one clock the reply writes with an offset, a residential milestone's placeholder date, says +13:00.
 */
export const FLIWAY_ZONE = 'Pacific/Auckland';
// A delivered consignment's reply is about 30 kB, most of it the signature image.
export const FLIWAY_MAX_BYTES = 1024 * 1024;

// The tracker takes a consignment note number or an item's number, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
// RedShield's block page, which its WAF sends with HTTP 403 in front of the tracker.
const BLOCKED = /RedShield|redshield\.co/;
// The lookups' answers for a number they do not know, each naming the number asked.
const CONNOTE_MISSING = /^Connote Number (\S{1,40}) is not found\.$/;
const ITEM_MISSING = /^Unknown Ticket: (\S{1,40})$/;
// "2024-07-17T13:29:19": a milestone's wall clock, without a zone; the proof of delivery adds milliseconds.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?$/;
// "2024-07-22T00:00:00": a milestone's expected day.
const DAY = /^(\d{4})-(\d{2})-(\d{2})T00:00:00$/;
const CODE = /^[A-Za-z]{2,40}$/;
// "17 Jul 24 13:29 Arrived AUCKLAND Depot": an item's row, its wall clock and its wording.
const ITEM_ROW = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) ([01]\d|2[0-3]):([0-5]\d) +(\S.{0,300})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A delivery row names whoever signed for it.
const SIGNER = /\s*Signed By:.*$/is;
const PICKED_UP = /^Picked Up (\S.{0,60})$/i;
const ARRIVED = /^Arrived (\S.{0,60}) Depot$/i;
// "1 of 2 Delivered": how many of the consignment's pieces are delivered.
const PIECES = /^(\d{1,4}) of (\d{1,4}) Delivered$/i;
// The proof of delivery a consignment has before any: a placeholder, not a delivery.
const NO_POD = 'No POD recorded';
/**
 * The depots an item's history names in words, by the code the consignment's milestones give them.
 * Another depot keeps its code.
 */
const DEPOTS: Readonly<Record<string, string>> = { AKL: 'Auckland', PMR: 'Palmerston North' };
const MAX_ROWS = 300;

/** A Fliway consignment note number or item number, as its tracker takes it: letters and digits. */
export function normalizeFliwayNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Fliway consignment or item number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The lookup's JSON reply; RedShield's block page, which can come with any status, is a challenge. */
export function fliwayPayload(body: string, contentType: string): unknown {
  if (BLOCKED.test(body.slice(0, 64_000)) && !/^\s*[{[]/.test(body)) {
    throw new ChallengeError(PROVIDER, "Fliway's firewall refused the lookup");
  }
  if (!/^application\/json\b/i.test(contentType)) return invalid('Fliway answered with a page instead of its tracking reply');
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Fliway returned a reply that is not JSON', { cause });
  }
}

const same = (value: string, number: string) => normalizeTrackingNumber(value) === number;

/**
 * Whether the reply is the lookup's own answer that it does not know the number: `{"error": "Connote Number <n> is
 * not found."}` from the consignment lookup, `{"error": "Unknown Ticket: <n>"}` from the item lookup, naming the
 * number asked. Another error, or one naming another number, says nothing about the number.
 */
export function fliwayMissing(payload: unknown, number: string, lookup: 'connote' | 'item'): boolean {
  if (!isRecord(payload) || payload.error === undefined) return false;
  const message = typeof payload.error === 'string' ? clean(payload.error, 200) : '';
  const named = (lookup === 'connote' ? CONNOTE_MISSING : ITEM_MISSING).exec(message)?.[1];
  if (named && same(named, number)) return true;
  if (named) throw new IndeterminateError(PROVIDER, 'Fliway answered for another number');
  throw new IndeterminateError(PROVIDER, 'Fliway answered the lookup with an error');
}

function textOf(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return invalid(`Fliway returned an invalid ${key}`);
  return clean(value, maxLength);
}

type Clock = Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> & { local_time: string; time: string };

/** A wall clock and its instant on New Zealand's clock, the carrier's, as the reply gives no zone. */
function dated(local: string): Clock {
  const time = isoTime(local, FLIWAY_ZONE)?.iso ?? invalid('Fliway returned an invalid time');
  return { local_time: local, time, time_zone: FLIWAY_ZONE, time_zone_basis: 'carrier' };
}

/** A milestone's clock to the second, or null when the field is empty. */
function clockOf(value: string): Clock | null {
  if (!value) return null;
  const parts = CLOCK.exec(value);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001) return invalid('Fliway returned an invalid time');
  return dated(`${day}T${parts[4]}:${parts[5]}:${parts[6]}`);
}

type Scan = CarrierEvent & Clock & { description: string };

/** Newest first; rows of one clock in the reverse of the reply's order, which runs oldest first. */
function newestFirst(rows: readonly Scan[]): Scan[] {
  const seen = new Set<string>();
  return rows.map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.provider_code ?? '', event.description, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index)
    .map(({ event }) => event);
}

/** "SomeEvent" as "Some Event", for a milestone the tracker's script has no label for. */
const spaced = (code: string) => code.replace(/([a-z])([A-Z])/g, '$1 $2');

/** A milestone row with a scan clock as a scan, or null for a milestone not scanned. */
function milestoneScan(row: Record<string, unknown>): Scan | null {
  const code = textOf(row, 'trackEvent', 40);
  if (!CODE.test(code)) return invalid('Fliway returned a milestone without its code');
  const clock = clockOf(textOf(row, 'scanDateTime', 40));
  if (!clock) return null;
  const depot = textOf(row, 'location', 60);
  const location = DEPOTS[depot] ?? depot;
  const description = fliwayMilestoneText(code) ?? spaced(code);
  const mapped = fliwayMilestoneStage(code);
  const staged = mapped ? { stage: mapped, source: 'carrier_map' } : fliwayItemStage(description);
  return { ...clock, description, provider_code: code, ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** The newest proof of delivery that is one, by its clock. */
function proofOfDelivery(payload: Record<string, unknown>): Clock | null {
  const pods = payload.pod ?? [];
  if (!Array.isArray(pods) || pods.length > MAX_ROWS) return invalid('Fliway returned an invalid proof of delivery');
  const clocks = pods.map((pod) => {
    if (!isRecord(pod)) return invalid('Fliway returned an invalid proof of delivery');
    // The receiver's name and signature stay behind; the name only tells a placeholder from a delivery.
    if (textOf(pod, 'PODName', 120) === NO_POD) return null;
    return clockOf(textOf(pod, 'PODDateTime', 40));
  }).filter((clock): clock is Clock => clock !== null);
  return clocks.sort((a, b) => b.local_time.localeCompare(a.local_time))[0] ?? null;
}

/**
 * The delivery estimate a consignment on its way has: the slot arranged with the receiver, unless a
 * delivery failed or the van came back, or the slot ended before the newest scan; else the delivery
 * milestone's expected day, unless it is before that scan's day.
 */
function estimateOf(row: Record<string, unknown> | undefined, newest: Scan | undefined):
  Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (!row) return { expected_delivery: null };
  const after = newest?.local_time ?? '';
  const start = clockOf(textOf(row, 'arrangedStartDateTime', 40));
  const end = clockOf(textOf(row, 'arrangedEndDateTime', 40));
  if (row.deliveryArranged === true && row.hasFutiledDelivery !== true && row.returnFromOFD !== true
    && start && end && end.local_time > start.local_time && end.local_time > after) {
    return { expected_delivery: end.time, expected_delivery_from: start.time };
  }
  const day = DAY.exec(textOf(row, 'expectedDate', 40));
  const expected = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  return { expected_delivery: expected && expected >= after.slice(0, 10) ? expected : null };
}

function summarized(events: Scan[], text: string, stageOf: (events: Scan[]) => CarrierEvent | undefined): CarrierResult {
  const lead = stageOf(events);
  const stage = lead?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: text || events[0]!.description,
    last_update: events[0]!.time,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    events,
  };
}

/**
 * Reads the consignment lookup's reply: `{connoteNumber, status, trackingRecords: [{trackEvent, status, location,
 * scanDateTime, expectedDate, deliveryArranged, arrangedStartDateTime, arrangedEndDateTime, ...}], pod: [...]}`.
 * The reply must echo the whole number asked. Each milestone with a scan clock is a scan, its depot named by its
 * code, or in words where an item's history names it; the milestones not reached, and the residential milestones
 * that carry no clock, are none. Every clock is a wall clock on New Zealand's clock. A proof of delivery gives the
 * delivery's clock when the delivery milestone has none; the receiver's name and signature stay behind. A
 * consignment some of whose pieces are not delivered yet is not delivered.
 */
export function parseFliwayConsignment(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) return invalid('Fliway returned an invalid reply');
  if (typeof payload.connoteNumber !== 'string' || !payload.connoteNumber.trim()) return invalid('Fliway returned a reply without its number');
  if (!same(payload.connoteNumber, number)) throw new IndeterminateError(PROVIDER, 'Fliway answered for another consignment');
  const rows = payload.trackingRecords ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('Fliway returned invalid milestones');
  const milestones = rows.map((row) => (isRecord(row) ? row : invalid('Fliway returned an invalid milestone')));
  const scans = milestones.map(milestoneScan).filter((scan): scan is Scan => scan !== null);
  const pod = proofOfDelivery(payload);
  if (pod && !scans.some((scan) => scan.stage === 'delivered')) {
    scans.push({ ...pod, description: fliwayMilestoneText('Delivered')!, provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
  }
  const events = newestFirst(scans);
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'Fliway lists the consignment without a scan', { reason: 'listed' });

  const text = textOf(payload, 'status', 120);
  const pieces = PIECES.exec(text);
  const partly = pieces !== null && Number(pieces[1]) < Number(pieces[2]);
  // While pieces are still on their way, the newest scan of another stage leads.
  const result = summarized(events, text, (scanned) => leadingScan(partly ? scanned.filter((event) => event.stage !== 'delivered') : scanned, statusMap));
  if (result.current_stage === 'delivered') return result;
  const delivery = milestones.find((row) => row.trackEvent === 'Delivered') ?? milestones.at(-1);
  return { ...result, ...estimateOf(delivery, events[0]) };
}

const townCase = (name: string) => name.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());

/** An item's row: its wall clock to the minute, its wording without the signer, and the place it names. */
function itemScan(row: unknown): Scan | null {
  if (typeof row !== 'string') return invalid('Fliway returned an invalid item row');
  const parts = ITEM_ROW.exec(clean(row, 400));
  const year = parts ? 2000 + Number(parts[3]) : 0;
  const day = parts ? calendarDay(year, MONTHS.indexOf(parts[2]!) + 1, Number(parts[1])) : null;
  if (!parts || !day) return invalid('Fliway returned an item row without its time');
  const description = parts[6]!.replace(SIGNER, '').trim();
  if (!description) return null;
  const depot = ARRIVED.exec(description)?.[1];
  const place = PICKED_UP.exec(description)?.[1] ?? (depot ? townCase(depot) : '');
  const staged = fliwayItemStage(description);
  return { ...dated(`${day}T${parts[4]}:${parts[5]}:00`), description, ...(place ? { location: place } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/**
 * Reads the item lookup's reply: `{trackNum, location, trackingRecords: ["17 Jul 24 13:29 Picked Up East Tamaki",
 * ...]}`, the rows oldest first and `location` the item's status. The reply must echo the whole number asked. Each
 * row keeps its wall clock, to the minute, on New Zealand's clock; the place is the suburb a pickup names or the
 * depot an arrival names. The name a delivery row gives after "Signed By:" stays behind.
 */
export function parseFliwayItem(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) return invalid('Fliway returned an invalid reply');
  if (typeof payload.trackNum !== 'string' || !payload.trackNum.trim()) return invalid('Fliway returned a reply without its number');
  if (!same(payload.trackNum, number)) throw new IndeterminateError(PROVIDER, 'Fliway answered for another item');
  const rows = payload.trackingRecords ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('Fliway returned an invalid item history');
  const events = newestFirst(rows.map(itemScan).filter((scan): scan is Scan => scan !== null));
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'Fliway lists the item without a scan', { reason: 'listed' });
  return summarized(events, textOf(payload, 'location', 120), (scanned) => leadingScan(scanned, statusMap));
}
