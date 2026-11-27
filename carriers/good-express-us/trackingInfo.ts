import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';

// The TrackingInfo page that forwarders carrying parcels from the United States to China run on ASP.NET:
// `TrackingInfo?TrackginNO=<number>`, the parameter spelled so. It renders each waybill asked as
// "运单号：<span class="text-danger">…</span>" over a table of rows, each a clock cell and a wording cell. A
// number the tracker does not know gets one row of the site's own wording, stamped with the moment of the
// lookup on the server's clock. Each site's template names the cells' classes its own way, lists the rows in
// its own order and stamps them on its own server's clock.

// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|h-captcha/i;
const WAYBILL = /运单号：\s*<span class="text-danger">\s*([^<]{0,64}?)\s*<\/span>([\s\S]*?)<\/table>/g;
const ROW = /<tr>\s*<td class="(?:left-label|w-fix-left-label)">([^<]*)<\/td>\s*<td class="text-(?:start|left)">([\s\S]*?)<\/td>\s*<\/tr>/g;
// "2026/11/6 17:46:51": month, day and hour without their leading zero.
const CLOCK = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/;

/** One site of the platform, as its errors name it. */
export interface TrackingInfoSite {
  readonly provider: string;
  readonly name: string;
  /** The only row of a number the tracker does not know. */
  readonly notFound: string;
  readonly maxRows: number;
}

/** A row as the page gives it: the clock cell's text and the wording cell's HTML. */
export interface TrackingInfoRow {
  readonly clock: string;
  readonly cell: string;
}

/**
 * The rows of the waybill whose number is the whole number asked, in the page's order. A page for another
 * number is indeterminate; the site's one not-found row is not found; a page whose rows cannot all be read
 * is a changed page.
 */
export function trackingInfoRows(html: string, number: string, site: TrackingInfoSite): TrackingInfoRow[] {
  const invalid = (message: string): never => { throw new SchemaError(site.provider, `${site.name} ${message}`); };
  if (CHALLENGE.test(html)) throw new ChallengeError(site.provider, `${site.name} returned a verification page`);
  const waybills = [...html.matchAll(WAYBILL)];
  if (waybills.length === 0) return invalid('returned a page without a waybill');
  const bound = waybills.filter((waybill) => normalizeTrackingNumber(textFromHtml(waybill[1], 64)) === number);
  if (bound.length !== 1) {
    if (bound.length === 0) throw new IndeterminateError(site.provider, `${site.name} answered for another number`);
    return invalid('listed the waybill twice');
  }
  const table = bound[0]![2]!;
  const rows = [...table.matchAll(ROW)];
  // Every row of the table must be read, or the page has changed.
  if (rows.length !== (table.match(/<tr\b/g) ?? []).length) return invalid('returned an unreadable row');
  if (rows.length > site.maxRows) return invalid('returned too many rows');
  if (rows.length === 1 && textFromHtml(rows[0]![2], 40) === site.notFound) {
    throw new NotFoundError(site.provider, `${site.name} has no tracking information for this waybill`);
  }
  if (rows.length === 0) return invalid('returned a waybill without rows');
  return rows.map(([, clock, cell]) => {
    if (textFromHtml(cell, 40) === site.notFound) return invalid('returned a row without its wording');
    return { clock: clock!.trim(), cell: cell! };
  });
}

/** A row's wall clock as an ISO date and time, its fields padded; null when it is not a clock or not a day. */
export function trackingInfoClock(value: string): string | null {
  const parts = CLOCK.exec(value.trim());
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  return `${day}T${parts[4]!.padStart(2, '0')}:${parts[5]}:${parts[6]}`;
}
