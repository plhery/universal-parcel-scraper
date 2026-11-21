import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { hiTransStage } from './status.js';

export const PROVIDER = 'Hi-Trans Express';
/** The consignment summary, which renders the consignment in its address on the server. */
export const HI_TRANS_SUMMARY = 'https://online.hi-trans.com.au/Connotes/ShowConsignmentSummary.aspx';
// A page with two signature images is under a hundred kilobytes.
export const HI_TRANS_MAX_BYTES = 2_000_000;

// A consignment note: the prefix that names the sender's charge account, then its counter, in at
// most fifteen characters, as the Freight API takes them.
const NUMBER = /^(?=.{4,15}$)[A-Z]{1,8}\d{1,14}$/;
// Bot checks a CDN could put in place of the page.
export const CHALLENGE = /_cf_chl_opt|cf-turnstile|cf-error-details|<title>\s*Just a moment|<title>\s*Attention Required/i;
// The page's data for its summary, written into a script before the page draws it.
const DATA = 'window.consignment = ';
const NOT_FOUND = /Consignment\/Quote\s+(\S{1,40})\s+not found/i;
// A scan's wall clock, to the millisecond, without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The depots by the city the page names, each on its state's clock.
const DEPOT_ZONES: Readonly<Record<string, string>> = {
  adelaide: 'Australia/Adelaide', brisbane: 'Australia/Brisbane', canberra: 'Australia/Sydney', darwin: 'Australia/Darwin',
  hobart: 'Australia/Hobart', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth', sydney: 'Australia/Sydney',
};
const MAX_EVENTS = 200;

/** A consignment note number as the summary takes it. */
export function normalizeHiTransNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hi-Trans Express consignment notes are letters then digits, up to fifteen');
  return number;
}

/** The summary's address for one consignment note. */
export function hiTransSummaryUrl(number: string): string {
  return `${HI_TRANS_SUMMARY}?${new URLSearchParams({ Number: normalizeHiTransNumber(number) })}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The consignment the page wrote into its script. */
function consignmentData(html: string): unknown {
  const start = html.indexOf(DATA);
  if (start < 0) return undefined;
  const end = html.indexOf('</script>', start);
  if (end < 0) return invalid('Hi-Trans Express returned a truncated consignment');
  try {
    return JSON.parse(html.slice(start + DATA.length, end).trim().replace(/;$/, ''));
  } catch {
    return invalid('Hi-Trans Express returned an unreadable consignment');
  }
}

/** The scan's wall clock, and its instant on the clock of the depot that scanned it. */
function clock(value: unknown, depot: string): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const wall = CLOCK.exec(text(value, 40))?.[1];
  if (!wall) return invalid('Hi-Trans Express returned a scan without its clock');
  const zone = DEPOT_ZONES[depot.toLowerCase()];
  const time = zone ? isoTime(wall, zone) : null;
  return time ? { time: time.iso, local_time: wall, time_zone: zone!, time_zone_basis: 'place' } : { local_time: wall };
}

/** The consignment's scans from the summary page, the newest first. */
export function parseHiTrans(html: string, number: string): CarrierResult {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hi-Trans Express answered with a browser check');
  const data = consignmentData(html);
  if (data === undefined) {
    const missing = NOT_FOUND.exec(html.replace(/<[^>]{0,200}>/g, ' '));
    if (!missing) return invalid('Hi-Trans Express returned a page without a consignment');
    if (missing[1]!.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Hi-Trans Express answered for another consignment');
    throw new NotFoundError(PROVIDER, 'Hi-Trans Express has no consignment for this number');
  }
  if (!isRecord(data) || !Array.isArray(data.consignmentStatusHistory)) return invalid('Hi-Trans Express returned a consignment without its history');
  if (text(data.consignmentNumber, 40).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Hi-Trans Express answered for another consignment');

  const events = data.consignmentStatusHistory.map((scan): CarrierEvent => {
    if (!isRecord(scan) || !Number.isSafeInteger(scan.statusCode)) return invalid('Hi-Trans Express returned an invalid scan');
    const code = String(scan.statusCode);
    const description = text(scan.statusDescription, 200);
    if (!description) return invalid('Hi-Trans Express returned a scan without its wording');
    const depot = text(scan.depot, 80);
    const stage = hiTransStage(code);
    return { ...clock(scan.dateTime, depot), description, provider_code: code, ...(depot ? { location: depot } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  // The reply lists the scans the oldest first, and the page shows them the other way round.
  }).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Hi-Trans Express lists the consignment without scans', { reason: 'listed' });
  const newest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = text(data.serviceDescription, 80);
  const sender = text(data.senderName, 120);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }), expected_delivery: null,
    ...(service ? { service_name: service } : {}), ...(sender ? { sender_name: sender } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
