import { load, type CheerioAPI } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, epochMillisTime, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** One carrier's portal on Transvirtual, the consignment software behind its public tracker. */
export interface TransvirtualPortal {
  /** The carrier's id. */
  carrier: string;
  /** The carrier's name, as errors give it. */
  provider: string;
  /** The portal's code, which the tracker's addresses and its `TvNumber` field name. */
  code: string;
  /** The tracker's address for one consignment, without the number: `https://…/Track/{code}/`. */
  tracker: string;
  /** A scan's stage, from the carrier's map or the shared wording rules. */
  stage: (wording: string) => ClassifiedWording | null;
}

// A consignment page is under twenty kilobytes.
export const TRANSVIRTUAL_MAX_BYTES = 1024 * 1024;

// Consignments open with a prefix set per sender; the tracker takes other references too.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// "19/06/2026 11:46 AM AEST": the day, a twelve-hour clock and, usually, the zone's abbreviation.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}) ([AP]M)(?: ([A-Z]{3,5}))?$/;
const HEADING = /^Current Status:\s*(.+)$/;
const TIMED_STATUS = /^(.+?):\s*(\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M(?: [A-Z]{3,5})?)$/;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?)\s*kgs?$/i;
// The tracker's answer for a number it has no consignment for, which is also its empty form's.
const NO_CONSIGNMENT = /Missing or incorrect tracking number/i;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|incapsula|imunify360/i;
// The Australian zones the page names, by abbreviation. Another stays a wall clock.
const OFFSETS: ReadonlyMap<string, string> = new Map([
  ['AEST', '+10:00'], ['AEDT', '+11:00'], ['ACST', '+09:30'], ['ACDT', '+10:30'], ['AWST', '+08:00'],
]);
// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
const EPOCH_TICKS = 621_355_968_000_000_000n;
const HOUR_MS = 3_600_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers every number with HTTP 200: a missing route is not a missing consignment.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** A number for the portal's tracker, in upper case; anything else is not one the carrier issues. */
export function normalizeTransvirtualNumber(portal: TransvirtualPortal, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(portal.provider, `${portal.provider} numbers are six to thirty letters and digits`);
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isTransvirtualBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

interface Clock {
  /** The calendar day the page shows, `YYYY-MM-DD`. */
  day: string;
  /** The instant, when the page names the zone or the scan carries one. */
  instant?: ParsedTime;
  /** The wall clock or day, when it does not. */
  local?: string;
}

/** A `d/MM/yyyy` day, validated. */
function dayOf(text: string): string | null {
  const match = DAY.exec(text);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** A `d/MM/yyyy h:mm AM ZONE` clock: an instant when the zone is known, else a wall clock. */
function clockOf(text: string): Clock | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const day = calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  const hour = Number(match[4]);
  if (!day || hour < 1 || hour > 12 || Number(match[5]) > 59) return null;
  const hours = String((hour % 12) + (match[6] === 'PM' ? 12 : 0)).padStart(2, '0');
  const wall = `${day}T${hours}:${match[5]}:00`;
  const offset = match[7] ? OFFSETS.get(match[7]) : undefined;
  const instant = offset ? explicitOffsetTime(`${wall}${offset}`) : null;
  return instant ? { day, instant } : { day, local: wall };
}

/**
 * The instant a grouped scan row carries in the address of its detail panel:
 * `{wording}:{place}||{day}||{consignment}||{first scan}||{last scan}`, the
 * scans as UTC ticks. Used only when the address names this row and this
 * consignment, and the first scan falls on the row's day in an Australian zone.
 */
function rowInstant(url: string | undefined, head: string, shownDay: string, day: string, consignment: string): ParsedTime | null {
  if (!url) return null;
  let id: string | null;
  try {
    id = new URL(url).searchParams.get('id');
  } catch {
    return null;
  }
  const parts = id?.split('||') ?? [];
  if (parts.length !== 5 || parts[0] !== head || parts[1] !== shownDay || parts[2] !== consignment) return null;
  const [first, last] = [parts[3]!, parts[4]!];
  if (!/^\d{18}$/.test(first) || !/^\d{18}$/.test(last) || BigInt(first) > BigInt(last)) return null;
  // To the second, as the other clocks are.
  const millis = Number((BigInt(first) - EPOCH_TICKS) / 10_000_000n) * 1000;
  // Australia's zones run from UTC+8 to UTC+11 in summer.
  const days = [8, 11].map((hours) => new Date(millis + hours * HOUR_MS).toISOString().slice(0, 10));
  return days.includes(day) ? epochMillisTime(millis) : null;
}

/** The text of the field the page labels `name`, or an empty string. */
function field($: CheerioAPI, name: string): string {
  return clean($(`label[name="${name}"] .label-Text`).first().text(), 200);
}

/** The delivery estimate: a day, or a window of two days. */
function estimate(text: string): { from: string | null; to: string } | null {
  const days = (text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) ?? []).map(dayOf);
  if (days.some((day) => !day)) return null;
  if (days.length === 1) return { from: null, to: days[0]! };
  if (days.length === 2 && days[0]! <= days[1]!) return { from: days[0]!, to: days[1]! };
  return null;
}

function weightOf(text: string): number | null {
  const match = WEIGHT.exec(text);
  const kilograms = match ? Number(match[1]) : NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

function eventOf(portal: TransvirtualPortal, clock: Clock, description: string, location: string): CarrierEvent {
  const staged = portal.stage(description);
  return {
    ...(clock.instant ? { time: clock.instant.iso } : { local_time: clock.local! }),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Whether `later` is after `earlier`: by their instants, else by a later day. */
function isAfter(later: Clock, earlier: Clock): boolean {
  if (later.instant && earlier.instant) return later.instant.timestamp > earlier.instant.timestamp;
  return later.day > earlier.day;
}

/**
 * The page a Transvirtual tracker serves at `/Track/{code}/{number}`. A
 * consignment gets a heading with its current status, its details (number,
 * the receiver's suburb and postcode, item count, weight and expected
 * delivery), the delivery's receiver and its history: grouped scan rows and
 * timed rows such as the pickup and the delivery, oldest first. A number the
 * tracker has no consignment for gets the empty form with "Missing or
 * incorrect tracking number", under an id built from the address asked.
 *
 * The page must be the portal's and its details must name the whole number
 * asked. The receiver's suburb and postcode, who received the delivery and
 * the item counts are not read.
 */
export function parseTransvirtualPage(portal: TransvirtualPortal, html: string, raw: string): CarrierResult {
  const { provider } = portal;
  const number = normalizeTransvirtualNumber(portal, raw);
  const $ = load(html);
  const code = $('input#TvNumber');
  const consignment = $('input#IdConsignment');
  if (!consignment.length) {
    const form = $('input#ConNumberEntry').closest('[id$="_EnterTrackingNumber"]');
    if (code.attr('value') === portal.code && form.length === 1 && NO_CONSIGNMENT.test(clean($('.consignmenttrackingpage').text(), 2000))) {
      // The form's id repeats the address asked: `Table_Track{code}{number}_EnterTrackingNumber`.
      if (form.attr('id')?.toUpperCase() !== `TABLE_TRACK${portal.code.toUpperCase()}${number}_ENTERTRACKINGNUMBER`) {
        throw new IndeterminateError(provider, `${provider} answered for another number`);
      }
      // Missing or incorrect: the tracker does not say the consignment does not exist.
      throw new IndeterminateError(provider, `${provider}'s tracker has no consignment for the number`, { reason: 'portal_not_found' });
    }
    if (isTransvirtualBlockPage(html)) throw new ChallengeError(provider, `${provider} answered with a browser check`);
    throw new SchemaError(provider, `${provider} returned an unexpected page`);
  }
  const consignmentId = clean(consignment.attr('value'), 40);
  if (consignment.length !== 1 || !/^\d{1,20}$/.test(consignmentId) || code.attr('value') !== portal.code) {
    throw new SchemaError(provider, `${provider} returned an unexpected page`);
  }
  const echoed = field($, 'ConsignmentNumber').toUpperCase();
  if (!echoed) throw new SchemaError(provider, `${provider} did not name the consignment`);
  if (echoed !== number) throw new IndeterminateError(provider, `${provider} answered for another consignment`);

  const headings = $('h2').filter((_, element) => HEADING.test(clean($(element).text(), 300)));
  if (headings.length !== 1) throw new SchemaError(provider, `${provider} returned no current status`);
  const current = HEADING.exec(clean(headings.text(), 300))![1]!;

  const tables = $('table.GridScansAdv');
  const columns = tables.find('thead th').map((_, element) => clean($(element).text(), 40)).get();
  if (tables.length !== 1 || columns.slice(1, 4).join('|') !== 'Event|Location|Date') {
    throw new SchemaError(provider, `${provider} history layout changed`);
  }
  const rows = tables.find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);

  const scans: { clock: Clock; event: CarrierEvent }[] = [];
  rows.each((_, element) => {
    const row = $(element);
    const cells = ['ScanType', 'Location', 'ScanDate'].map((name) => row.children(`td.${name}`));
    if (cells.some((cell) => cell.length !== 1)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const [description, location, shown] = cells.map((cell) => clean(cell.text(), 200)) as [string, string, string];
    if (!description) throw new SchemaError(provider, `${provider} returned a scan without wording`);
    let clock = clockOf(shown);
    const day = clock ? null : dayOf(shown);
    if (day) {
      const instant = rowInstant(row.children('td').first().attr('childsectionurl'), `${description}:${location}`, shown, day, consignmentId);
      clock = instant ? { day, instant } : { day, local: day };
    }
    if (!clock) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
    scans.push({ clock, event: eventOf(portal, clock, description, location) });
  });

  // A dated status above the history that is newer than every scan, such as
  // the van leaving the depot, is the newest step.
  const timed = TIMED_STATUS.exec(current);
  const headingClock = timed ? clockOf(timed[2]!) : null;
  if (timed && headingClock && scans.every(({ clock }) => isAfter(headingClock, clock))) {
    scans.push({ clock: headingClock, event: eventOf(portal, headingClock, timed[1]!, '') });
  }
  if (!scans.length) throw new NoHistoryError(provider);

  // Oldest first, as the page lists them.
  const events = scans.map(({ event }) => event).reverse();
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time ?? null : null;
  const finished = stage === 'delivered' || stage === 'returned';
  const expected = finished ? null : estimate(field($, 'TransitText'));
  const weight = weightOf(field($, 'TotalWeight'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: expected?.to ?? null,
    ...(expected?.from ? { expected_delivery_from: expected.from } : {}),
    delivered_at: delivered,
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The tracker's address for one consignment, as its search box builds it. */
export function transvirtualLookupUrl(portal: TransvirtualPortal, number: string): string {
  return `${portal.tracker}${encodeURIComponent(number)}`;
}

export interface TransvirtualOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

/** Reads one consignment's page from a portal's tracker. */
export class TransvirtualTracker {
  constructor(private readonly portal: TransvirtualPortal, private readonly options: TransvirtualOptions = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.portal;
    const { response, bytes } = await fetchBounded(transvirtualLookupUrl(this.portal, number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TRANSVIRTUAL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const { status } = response;
    if (status === 403) throw new ChallengeError(provider, `${provider} refused the lookup`, { status });
    if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(provider, `${provider} tracker is unavailable`, { status });
    return parseTransvirtualPage(this.portal, decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTransvirtualNumber(this.portal, raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: this.portal.carrier, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

/**
 * The adapter for a portal. It declares no recognition: the tracker's answer
 * for a number it has no consignment for is inconclusive, and consignment
 * prefixes name senders.
 */
export function transvirtualAdapter(portal: TransvirtualPortal): AdapterFactory {
  return (environment) => {
    const tracker = new TransvirtualTracker(portal, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: portal.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
    };
  };
}
