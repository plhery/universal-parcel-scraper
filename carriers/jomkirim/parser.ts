import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { jomkirimStage } from './status.js';

export const PROVIDER = 'jomkirim';
export const JOMKIRIM_ORIGIN = 'https://courier.jomkirim.com';
/** The tracking form, where the tracker sends a code it does not know with its notice. */
export const JOMKIRIM_FORM = `${JOMKIRIM_ORIGIN}/shipment/tracking`;
// A shipment's page is a few kilobytes of markup and the theme's scripts.
export const JOMKIRIM_MAX_BYTES = 512 * 1024;

// The courier script's shipment codes: its prefix, then the shipment's serial.
const NUMBER = /^[A-Z]{1,10}\d{3,15}$/;
// "3 years ago (02-03-2023 12:41:41pm)": the tracker's wall clock, after how long ago it was.
const CLOCK = /\((\d{2})-(\d{2})-(\d{4}) (0\d|1[0-2]):([0-5]\d):([0-5]\d) ?([ap]m)\)$/i;
const HEADING = /^Shipment: ?(\S{1,64})$/;
// The notice the form shows after the tracker sends it a code it has no shipment under.
const UNKNOWN = /AIZ\.plugins\.notify\(\s*'danger'\s*,\s*'Invalid shipment code'\s*\)/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|hcaptcha\.com|sgcaptcha|imunify360/i;
const MAX_ROWS = 200;

/** A Jomkirim shipment code, in capitals as the tracker shows it. */
export function normalizeJomkirimNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jomkirim shipment codes are a letter prefix and digits');
  return number;
}

/** The tracker's page for one shipment code, which the tracking form opens. */
export const jomkirimTrackingUrl = (raw: string): string => `${JOMKIRIM_FORM}/${normalizeJomkirimNumber(raw)}`;

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

export function isJomkirimChallenge(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/**
 * The tracking form the tracker sends an unknown code to: with its notice for the session that
 * asked, the code is not found; without one, nothing says why the shipment was not shown.
 */
export function readJomkirimForm(html: string): never {
  if (isJomkirimChallenge(html)) throw new ChallengeError(PROVIDER, 'Jomkirim answered with a browser check');
  const $ = load(html);
  if ($('form[action$="/shipment/tracking"] input[name="code"]').length !== 1) {
    return invalid('Jomkirim sent the lookup to a page other than its tracking form');
  }
  if (UNKNOWN.test(html)) throw new NotFoundError(PROVIDER, 'Jomkirim has no shipment under this code');
  throw new IndeterminateError(PROVIDER, 'Jomkirim sent the lookup back to its form without a notice');
}

function wallClock(cell: string): string {
  const parts = CLOCK.exec(cell);
  const day = parts ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!parts || !day || Number(parts[3]) < 2015) return invalid('Jomkirim returned an invalid history time');
  const hour = Number(parts[4]) % 12 + (parts[7]!.toLowerCase() === 'pm' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${parts[5]}:${parts[6]}`;
}

/**
 * A shipment's page: its code, its current status and its history, oldest first. Each row's
 * clock is the tracker's wall clock with no zone, after how long ago it was, which is left out.
 * The two cells after the wording, empty on every row seen, are not read.
 */
export function parseJomkirim(html: string, raw: string): CarrierResult {
  const number = normalizeJomkirimNumber(raw);
  if (isJomkirimChallenge(html)) throw new ChallengeError(PROVIDER, 'Jomkirim answered with a browser check');
  const $ = load(html);
  const headings = $('h1').toArray().map((heading) => HEADING.exec(clean($(heading).text(), 80))?.[1]).filter(Boolean);
  if (headings.length !== 1) return invalid('Jomkirim returned a page without one shipment');
  if (headings[0]!.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Jomkirim answered for another shipment');

  const label = $('span').filter((_, span) => clean($(span).text(), 40) === 'Current Status');
  if (label.length !== 1) return invalid('Jomkirim returned a shipment without its current status');
  const current = clean(label.next('span').text(), 120);

  const tables = $('table');
  if (tables.length !== 1) return invalid('Jomkirim returned a page without one history table');
  const columns = tables.find('thead th').toArray().map((cell) => clean($(cell).text(), 40));
  if (columns.join('|') !== 'Date|Details') return invalid('Jomkirim changed its history columns');
  const rows = tables.find('tbody tr').toArray();
  if (rows.length > MAX_ROWS) return invalid('Jomkirim returned too many history rows');

  // The table runs oldest first: the result lists the newest first, and of rows at one second the later.
  const seen = new Set<string>();
  const events = rows.map((row, index) => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 200));
    const description = cells[1];
    if (cells.length < 2 || !description) return invalid('Jomkirim returned an incomplete history row');
    const staged = jomkirimStage(description);
    const event: CarrierEvent & { local_time: string } = { local_time: wallClock(cells[0]!), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    return { index, event };
  }).filter(({ event }) => {
    const key = `${event.local_time}|${event.description}`;
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);

  if (!current && events.length === 0) return invalid('Jomkirim returned a shipment without a status or history');
  // The current status heads the page; a wording no rule reads leaves it to the newest staged row.
  const headed = current ? jomkirimStage(current) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (headed?.stage ?? scanned?.stage) as Stage | undefined;
  const source = headed?.source ?? scanned?.stage_source;
  const newest = events[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: current || newest?.description || null,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : { summary_only: true }),
    expected_delivery: null,
    events,
  };
}
