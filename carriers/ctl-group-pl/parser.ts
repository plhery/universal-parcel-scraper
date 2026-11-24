import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { ctlGroupStage } from './status.js';

export const PROVIDER = 'ctl-group-pl';
// The tracking page is about 25 kilobytes.
export const MAX_BYTES = 512_000;
// The waybill number printed under the label's barcode, in digits. The tracker's form takes it
// without a mask; its label example has six digits and the waybills on its help page eight.
const NUMBER = /^\d{6,12}$/;
// "2020-11-20 10:30:14": a scan's wall clock, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const NOT_FOUND = 'Brak zamówienia z podanym numerem listu przewozowego';
const MAX_ROWS = 200;
// Bot checks a firewall could put in place of the page. The page loads reCAPTCHA for its
// separate driver-phone form, so the word alone is no sign of one.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|awswaf|<title>\s*(?:Just a moment|Access Denied|Attention Required|Request Rejected)/i;

/** A waybill number as the tracker takes it: the digits under the label's barcode. */
export function normalizeCtlGroupNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the CTL Group waybill number printed under the label’s barcode');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function scan(cells: string[]): CarrierEvent & { local_time: string; description: string } {
  const [clock = '', place = '', wording = ''] = cells;
  const digits = CLOCK.exec(clock);
  if (cells.length !== 3 || !digits || !wording) return invalid('CTL Group returned an unreadable scan');
  const [, year, month, day, hour, minute, second] = digits;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  // Luxon rolls an impossible clock over, so only one that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || Number(year) < 2001 || Number(year) > 2100) {
    return invalid('CTL Group returned an unreadable scan');
  }
  const stage = ctlGroupStage(wording);
  return { local_time: wall, description: wording, ...(place ? { location: place } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/** Reads the tracking page the tracker answers for a waybill number: its history, or its not-found notice. */
export function parseCtlGroup(html: string, number: string): CarrierResult {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CTL Group answered with a browser check');
  const $ = load(html);
  // The page puts the number it looked up back in its form.
  const form = $('form[action="/orders/tracking"]');
  if (form.length !== 1) return invalid('CTL Group returned a page without its tracking form');
  if (clean(form.find('input[name="tracking_number"]').attr('value'), 64) !== number) {
    throw new IndeterminateError(PROVIDER, 'CTL Group answered for another waybill number');
  }
  const table = $('table.dane');
  if (!table.length) {
    if (clean($('div.message.error').text()) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    return invalid('CTL Group returned neither a history nor its not-found notice');
  }
  const headings = table.find('th').toArray().map((cell) => clean($(cell).text()));
  if (table.length !== 1 || headings.join('|') !== 'Data|Miejsce|Status') return invalid('CTL Group changed its history table');
  const rows = table.find('tr').toArray().map((row) => $(row).children('td').toArray().map((cell) => clean($(cell).text(), 200)))
    .filter((cells) => cells.length);
  if (rows.length > MAX_ROWS) return invalid('CTL Group returned too many scans');

  // The table lists the scans oldest first.
  const seen = new Set<string>();
  const events = rows.map(scan).map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'CTL Group lists the waybill without scans', { reason: 'listed' });

  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
