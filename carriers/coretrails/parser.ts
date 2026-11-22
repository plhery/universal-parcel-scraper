import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { coretrailsCodeStage, coretrailsStage } from './status.js';

export const PROVIDER = 'coretrails';
// A shipment's reply is a few kilobytes.
export const CORETRAILS_MAX_BYTES = 512 * 1024;

// The tracker takes only Coretrails' own numbers, which start with CRT.
const NUMBER = /^CRT\d{6,24}$/;
// "Mon, 19 Oct 2026 11:28:00 GMT": the scan's wall clock, labelled GMT by the server's date format.
const CLOCK = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) GMT$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const CODE = /^[A-Z][A-Z_]{1,39}$/;
const MAX_SCANS = 300;

// "SENECA ROCKS, WV 26884", "Casper WY 82601": a town, its state and its ZIP code.
const TOWN = /^[A-Za-z][A-Za-z .'-]{0,60}?,? [A-Z]{2} \d{5}$/;
// "DULLES VA DISTRIBUTION CENTER": a facility's name, without a number.
const FACILITY = /^[A-Za-z][A-Za-z .'&()/-]{1,80}$/;
// A post office named after its town, then its street address, town, state, ZIP+4 code and opening hours.
const OFFICE = /^([A-Za-z][A-Za-z .'-]{0,60}?) \d[^,]{0,120}? \1,? ([A-Z]{2}) (\d{5})(?:-\d{4})?\b/;

/** A number for Coretrails' tracker: CRT and digits. */
export function normalizeCoretrailsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Coretrails tracking numbers start with CRT');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function clockOf(value: string): string | undefined {
  const parts = CLOCK.exec(value);
  const date = parts ? calendarDay(Number(parts[3]), MONTHS.indexOf(parts[2]!) + 1, Number(parts[1])) : null;
  return parts && date ? `${date}T${parts[4]}:${parts[5]}:${parts[6]}` : undefined;
}

/** The estimate's day, as the server's date format or an ISO date gives it; null for anything else. */
function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clock = clockOf(value.trim());
  if (clock) return clock.slice(0, 10);
  const parts = ISO_DAY.exec(value.trim());
  return parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
}

/**
 * Where a scan happened, as a town, state and ZIP code or a facility's name. The recipient's
 * street or post office box, and a post office's street address and hours, stay behind; a place
 * that reads as neither is left out.
 */
export function coretrailsPlace(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  // "po box 14 , seneca rocks, wv, 26884-0014, US": the recipient's address, by its parts.
  const parts = text.split(',').map((part) => part.trim());
  for (let index = 1; index + 1 < parts.length; index += 1) {
    const zip = /^(\d{5})(?:-\d{4})?$/.exec(parts[index + 1]!);
    if (/^[A-Za-z]{2}$/.test(parts[index]!) && zip && /^[A-Za-z][A-Za-z .'-]{0,60}$/.test(parts[index - 1]!)) {
      return `${parts[index - 1]}, ${parts[index]!.toUpperCase()} ${zip[1]}`;
    }
  }
  if (TOWN.test(text) || FACILITY.test(text)) return text;
  const office = OFFICE.exec(text);
  return office ? `${office[1]}, ${office[2]} ${office[3]}` : undefined;
}

function scansOf(value: unknown): (CarrierEvent & { local_time: string; description: string })[] {
  if (!Array.isArray(value) || value.length > MAX_SCANS) return invalid('Coretrails returned an invalid list of scans');
  const seen = new Set<string>();
  const events: (CarrierEvent & { local_time: string; description: string })[] = [];
  for (const scan of value) {
    if (!isRecord(scan) || typeof scan.content !== 'string' || typeof scan.date !== 'string'
      || (scan.location != null && typeof scan.location !== 'string')) return invalid('Coretrails returned an invalid scan');
    const description = scan.content.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!description) continue;
    const localTime = clockOf(scan.date.trim()) ?? invalid('Coretrails returned an invalid scan time');
    const location = coretrailsPlace(typeof scan.location === 'string' ? scan.location.slice(0, 300) : '');
    const staged = coretrailsStage(description);
    const event = { local_time: localTime, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  return events;
}

/**
 * Reads the tracking reply for one number: its status code, an estimate when it has one, and the
 * scans newest first on the wall clock of each place. The reply must name the whole number asked.
 */
export function parseCoretrails(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCoretrailsNumber(raw);
  if (!isRecord(payload) || typeof payload.tracking_number !== 'string') return invalid('Coretrails returned an unreadable reply');
  if (normalizeTrackingNumber(payload.tracking_number.slice(0, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Coretrails answered for another number');
  }
  const code = payload.latest_status ?? null;
  if (code !== null && (typeof code !== 'string' || !CODE.test(code))) return invalid('Coretrails returned an invalid status');
  const events = scansOf(payload.shipping_events);
  if (!code && events.length === 0) return invalid('Coretrails returned a shipment without a status or scans');

  // Scans keep the reply's order, newest first: wall clocks across time zones do not sort as instants.
  const newest = events[0];
  const coded = code ? coretrailsCodeStage(code) : undefined;
  const stage = (coded ?? newest?.stage) as Stage | undefined;
  const source = coded ? 'carrier_map' : newest?.stage_source;
  const expected = dayOf(payload.est_delivery_date);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: newest?.description ?? code!.replaceAll('_', ' '),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
