import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { topparcelStage } from './status.js';

export const PROVIDER = 'topparcel';
// A result page is about 60 kB; a long history adds a few.
export const TOPPARCEL_MAX_BYTES = 512 * 1024;

// The tracker takes the number of the courier or post Topparcel booked, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
// "19.10.2026 11:00": a wall clock without a zone, Topparcel's own rows and the partner's on different clocks.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
const COUNTRY = /^[A-Z]{2}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;
const MAX_ROWS = 300;

/** A number for Topparcel's tracker: the booked courier's or post's tracking number. */
export function normalizeTopparcelNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the tracking number of the courier Topparcel booked');
  return number;
}

export const isTopparcelChallenge = (html: string): boolean => CHALLENGE.test(html);

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The tracking form's token, which its post must carry with the session that received it. */
export function topparcelFormToken(html: string): string {
  if (isTopparcelChallenge(html)) throw new ChallengeError(PROVIDER, 'Topparcel requires verification');
  const token = load(html)('form#parcel-tracking-form input[name="TOPPARCEL_CSRF_TOKEN"]').attr('value');
  return token && /^[A-Za-z0-9+/=_-]{20,200}$/.test(token) ? token : invalid('Topparcel changed its tracking form');
}

function sidebar($: CheerioAPI): Map<string, string> {
  return new Map($('aside.tracking-sidebar dl > div').toArray()
    .map((item) => [clean($(item).children('dt').text(), 40), clean($(item).children('dd').text(), 120)]));
}

function clockOf(value: string): string {
  const parts = CLOCK.exec(value);
  const date = parts ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!parts || !date || Number(parts[3]) < 2001) return invalid('Topparcel returned an invalid row time');
  return `${date}T${parts[4]}:${parts[5]}:00`;
}

type Row = CarrierEvent & { local_time: string; description: string };
type Cell = ReturnType<CheerioAPI>;

/** The rows of the details table, newest first: Topparcel's own steps, then those of the courier or post it booked. */
function rowsOf($: CheerioAPI): Row[] {
  const rows = $('table.tracking-table > tbody > tr').toArray();
  if (rows.length > MAX_ROWS) return invalid('Topparcel returned too many rows');
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const cells = $(row).children('td').toArray();
    if (cells.length !== 4) return invalid('Topparcel returned an invalid row');
    const [clock, country, address, status] = cells.map((cell) => $(cell)) as [Cell, Cell, Cell, Cell];
    const code = clean(country.text(), 10);
    if (code && !COUNTRY.test(code)) return invalid('Topparcel returned an invalid row country');
    // The status's first line; a delivery's second gives the post office's address.
    const lines = status.children('p');
    const description = clean((lines.length ? lines.first() : status).text(), 300) || invalid('Topparcel returned a row without a status');
    const location = [clean(address.text(), 120), code].filter(Boolean).join(', ');
    const staged = topparcelStage(description);
    const event: Row = { local_time: clockOf(clean(clock.text(), 30)), description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);
}

/**
 * Reads the result page for one number. The parcel's weight and the post office's address stay
 * behind; rows keep their wall clock, as the page gives no zone.
 */
export function parseTopparcel(html: string, number: string): CarrierResult {
  const $ = load(html);
  const fields = sidebar($);
  if (!$('table.tracking-table').length || !fields.has('Tracking #')) {
    if ($('p').toArray().some((item) => clean($(item).text(), 40) === 'Parcel not found')) throw new NotFoundError(PROVIDER);
    if (isTopparcelChallenge(html)) throw new ChallengeError(PROVIDER, 'Topparcel requires verification');
    return invalid('Topparcel returned an unknown page');
  }
  if (normalizeTrackingNumber(fields.get('Tracking #') ?? '') !== number) throw new IndeterminateError(PROVIDER, 'Topparcel answered for another parcel');
  const events = rowsOf($);
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'Topparcel lists the parcel without its steps', { reason: 'listed' });
  const current = events.find((event) => event.stage);
  // "Russia, Burevestnik": the country, then the town.
  const destination = countryCode(fields.get('Delivering to')?.split(',')[0]);
  return {
    status: current ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: events[0]!.description,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
