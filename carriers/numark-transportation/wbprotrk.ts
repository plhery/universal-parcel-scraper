/**
 * `wbprotrk`, the PRO trace of the TGIF ("The Great Information Factory") LTL freight system,
 * which each carrier runs on its own host: NuMark Transportation, and Dedicated Delivery
 * Professionals among others. A GET with the PRO number in `wbfb` answers a server page: the
 * PRO number, the shipper, consignee and debtor, then one row per status, oldest first. Each
 * carrier keeps its own tracker address, number rule and status map; this module holds the
 * request and the reader they share.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** One carrier's trace. */
export interface WbprotrkTenant {
  /** The catalog id errors carry. */
  readonly provider: string;
  /** The carrier's name, for messages. */
  readonly name: string;
  /** The trace's address, without a query. */
  readonly tracker: string;
  /** The stage the carrier's map gives a row's status wording. */
  readonly stage: (wording: string) => Stage | undefined;
}

// The page is a few kilobytes; a long history adds a line per status.
export const WBPROTRK_MAX_BYTES = 256 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];

const CHALLENGE = /cf-chl-|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// The trace's message above its form: a PRO number without a bill, one it does not take, or another.
const MESSAGE = /^(?:Error\b|Invalid\b)/i;
const NOT_FOUND = /^Error: Bill not found$/i;
const REFUSED = /^Invalid Pro number\b/i;
// The heading above the parties: "Pro: 138762265".
const IDENTITY = /^Pro:\s*(\S+)$/;
// "20170406": a status's day. A row gives no clock but the driver's in and out.
const DAY = /^(\d{4})(\d{2})(\d{2})$/;
// "1355": the driver's clock in or out, to the minute, on the local clock.
const CLOCK = /^([01]\d|2[0-3])([0-5]\d)$/;
// A terminal, by its town.
const TERMINAL = /^[A-Z][A-Z .'/-]{0,39}$/i;
// The consignee's town line, "SAN CARLOS, CA 94070-0000": its town and state.
const TOWN = /^([A-Z][A-Z .'-]{0,39}),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/i;
const COLUMNS = ['Status', 'Date', 'In', 'Out', 'Origin Term', 'Destination Term'] as const;
const MAX_ROWS = 200;

/** The trace's address for a PRO number, as its form sends it. */
export function wbprotrkUrl(tenant: WbprotrkTenant, pro: string): URL {
  const url = new URL(tenant.tracker);
  url.search = new URLSearchParams({ wbfb: pro, wbscac: '', idbutton: 'Trace' }).toString();
  return url;
}

/** Asks the trace about a PRO number and reads its answer. */
export async function fetchWbprotrk(tenant: WbprotrkTenant, pro: string, options: {
  signal: AbortSignal; timeoutMs: number; fetcher?: typeof fetch; userAgent?: string;
}): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(wbprotrkUrl(tenant, pro), {
    signal: options.signal, headers: { 'User-Agent': userAgentOf(options.userAgent), Accept: 'text/html' },
  }, {
    provider: tenant.provider, timeoutMs: options.timeoutMs, maxBytes: WBPROTRK_MAX_BYTES, redirect: 'manual',
    fetcher: options.fetcher, allowHttpStatuses: REDIRECTS,
  });
  // A redirect is a moved trace, not a missing bill.
  if (REDIRECTS.includes(response.status)) {
    throw new TransportError(tenant.provider, `${tenant.name}'s PRO trace moved`, { status: response.status });
  }
  // The trace writes ISO-8859-1.
  return parseWbprotrk(decodeText(bytes, 'windows-1252'), pro, tenant);
}

const cellsOf = ($: CheerioAPI, row: Element) => $(row).children('td').toArray().map((cell) => clean($(cell).text(), 120));

/** The consignee's town and state, without its name or postcode, when the page gives them as expected. */
function consigneeTown($: CheerioAPI): string | undefined {
  const label = $('b').filter((_, element) => clean($(element).text(), 40) === 'Consignee');
  if (label.length !== 1) return undefined;
  // The label's table, then the name's, then the town line's.
  const line = clean(label.closest('table').nextAll('table').eq(1).text(), 120);
  const town = TOWN.exec(line);
  return town ? `${town[1]}, ${town[2]}` : undefined;
}

/**
 * Reads the trace's page for one PRO number. A row keeps its status, its day, the driver's
 * clock when one is given and its terminal. The signature column, which gives a manifest
 * number or who signed, the shipper, the consignee's name and postcode, the debtor and the
 * references stay behind.
 */
export function parseWbprotrk(html: string, pro: string, tenant: WbprotrkTenant): CarrierResult {
  const { provider, name } = tenant;
  if (!html.trim()) throw new IndeterminateError(provider, `${name} returned an empty page`);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${name} answered with a verification page`);
  const $ = load(html);
  const field = $('input[name="wbfb"]');
  if (field.length !== 1) throw new SchemaError(provider, `${name} returned a page without its PRO trace`);

  const message = $('font b').toArray().map((element) => clean($(element).text(), 200)).find((text) => MESSAGE.test(text));
  if (message) {
    if (clean(field.attr('value'), 40) !== pro) throw new IndeterminateError(provider, `${name} answered for another PRO number`);
    if (NOT_FOUND.test(message)) throw new NotFoundError(provider, `${name} has no bill under this PRO number`);
    if (REFUSED.test(message)) throw new InvalidInputError(provider, `${name} does not take this PRO number`);
    throw new SchemaError(provider, `${name} answered with an unknown message`);
  }
  const identities = $('b').toArray().flatMap((element) => IDENTITY.exec(clean($(element).text(), 60))?.[1] ?? []);
  if (identities.length !== 1) throw new SchemaError(provider, `${name} returned a page without one PRO number`);
  if (identities[0] !== pro) throw new IndeterminateError(provider, `${name} answered for another PRO number`);

  const heading = $('tr').toArray().find((row) => {
    const cells = cellsOf($, row);
    return cells.includes('Status') && cells.includes('Date');
  });
  // A bill without a status yet.
  if (!heading) throw new NoHistoryError(provider, `${name} lists the bill without a status`, { reason: 'listed' });
  const headings = cellsOf($, heading);
  const [status, date, clockIn, clockOut, origin, destination] = COLUMNS.map((column) => headings.indexOf(column));
  if ([status, date, clockIn, clockOut, origin, destination].some((index) => index === -1)) {
    throw new SchemaError(provider, `${name} changed its status columns`);
  }
  const rows = $(heading).nextAll('tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${name} returned too many statuses`);

  const terminal = (value: string) => (TERMINAL.test(value) ? value : undefined);
  const events = rows.map((row): CarrierEvent & { local_time: string } => {
    const cells = cellsOf($, row);
    const wording = cells[status!];
    const day = DAY.exec(cells[date!] ?? '');
    const calendar = day && Number(day[1]) >= 1990 ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
    if (cells.length !== headings.length || !wording || !calendar) throw new SchemaError(provider, `${name} returned an incomplete status`);
    // The out clock is when the driver left, the receipt signed; the in clock serves without one.
    const written = cells[clockOut!] || cells[clockIn!];
    const clock = written ? CLOCK.exec(written) : null;
    if (written && !clock) throw new SchemaError(provider, `${name} returned an invalid clock`);
    // A transfer's row runs from the terminal it leaves to the one it heads for: it happens at the first.
    const location = terminal(cells[origin!]!) ?? terminal(cells[destination!]!);
    const stage = tenant.stage(wording);
    return {
      description: wording,
      local_time: clock ? `${calendar}T${clock[1]}:${clock[2]}:00` : calendar,
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });
  // Newest first, keeping the page's order among the statuses of one day.
  events.reverse().sort((left, right) => right.local_time.slice(0, 10).localeCompare(left.local_time.slice(0, 10)));
  const newest = events[0];
  if (!newest) throw new NoHistoryError(provider, `${name} lists the bill without a status`, { reason: 'listed' });

  const town = consigneeTown($);
  return {
    status: newest.stage ? languageStageStatus(newest.stage as Stage) : 'unknown',
    ...(newest.stage ? { current_stage: newest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    ...(town ? { receiver_address: town } : {}),
    events,
  };
}
