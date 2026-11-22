import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { libertyStage } from './status.js';

export const PROVIDER = 'Liberty Express';
export const LIBERTY_ORIGIN = 'https://iqpack.libertyexpress.com';
/** The search page, whose form carries the anti-forgery token and takes the number. */
export const LIBERTY_SEARCH = `${LIBERTY_ORIGIN}/SearchGuide`;
/** The tracking page the search sends a number it finds to, with the warehouse receipt in `nGuia`. */
export const LIBERTY_TRACKING = `${LIBERTY_ORIGIN}/Tracking`;
// Each page is about 7 kB; a history adds a few hundred bytes a row.
export const LIBERTY_MAX_BYTES = 256 * 1024;

// A warehouse receipt, "WR01-" and nine digits; a package's label adds its four digits after them.
const NUMBER = /^WR(\d{2})(\d{9}(?:\d{4})?)$/;
const RECEIPT = /^WR\d{2}-\d{9}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,1024}$/;
// A row's clock as the page's `datetime` attribute gives it, with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const NOT_FOUND = /^El n[uú]mero de la gu[ií]a no existe/i;
// The page the site sends a lookup it cannot answer to.
const MESSAGE_PAGE = /^\/Message\/?$/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|_Incapsula_Resource/i;
const MAX_ROWS = 200;

/**
 * A Liberty Express warehouse receipt as its search form takes it, "WR01-"
 * and nine digits, or a package's label number, the receipt and four digits.
 */
export function normalizeLibertyNumber(raw: string): string {
  const parts = NUMBER.exec(raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!parts) {
    throw new InvalidInputError(PROVIDER, 'Liberty Express warehouse receipts are WR, two digits, a hyphen and nine digits');
  }
  return `WR${parts[1]}-${parts[2]}`;
}

/** The warehouse receipt a number belongs to: a package's label number without its package digits. */
export function libertyReceipt(number: string): string {
  return number.slice(0, 14);
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isLibertyChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isLibertyChallenge(html)) throw new ChallengeError(PROVIDER, 'Liberty Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The anti-forgery token of the search page's form. */
export function parseLibertyForm(html: string): string {
  const $ = load(html);
  const forms = $('form[action="/SearchGuide"]');
  if (forms.length !== 1 || forms.find('input[name="NGuia"]').length !== 1) unexpected(html, 'Liberty Express search page has no tracking form');
  const tokens = forms.find('input[name="__RequestVerificationToken"]');
  const token = tokens.length === 1 ? tokens.attr('value') ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'Liberty Express tracking form changed');
  return token;
}

/**
 * The search page the form posts back to when it finds nothing: the number in
 * the field and a notice under it. The not-found notice says the guide does
 * not exist; any other notice is no answer about the number.
 */
export function parseLibertySearch(html: string, number: string): never {
  const $ = load(html);
  const field = $('form[action="/SearchGuide"] input[name="NGuia"]');
  const notice = $('form[action="/SearchGuide"] #msgError');
  if (field.length !== 1 || notice.length !== 1) unexpected(html, 'Liberty Express search page has no tracking form');
  if (clean(field.attr('value') ?? '', 64).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Liberty Express answered for another number');
  }
  if (NOT_FOUND.test(clean(notice.text(), 200))) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Liberty Express returned the search page without its not-found notice');
}

/**
 * Where the search sends a number it finds: the tracking page of its warehouse
 * receipt. The site's message page is no answer; any other place is a moved route.
 */
export function libertyTrackingUrl(location: string | null, number: string): string {
  if (isLibertyMessagePage(location)) throw new IndeterminateError(PROVIDER, 'Liberty Express sent the lookup to its message page');
  let target: URL | null;
  try {
    target = location ? new URL(location, `${LIBERTY_ORIGIN}/`) : null;
  } catch {
    target = null;
  }
  if (target?.origin !== LIBERTY_ORIGIN || target.pathname !== '/Tracking') throw new TransportError(PROVIDER, 'Liberty Express moved its tracking page');
  const receipt = target.searchParams.get('nGuia')?.trim().toUpperCase() ?? '';
  if (receipt !== libertyReceipt(number)) throw new IndeterminateError(PROVIDER, 'Liberty Express answered for another warehouse receipt');
  return `${LIBERTY_TRACKING}?${new URLSearchParams({ nGuia: receipt, fromMobileApp: 'False', fromReactApp: 'False' })}`;
}

/** Whether a redirect goes to the site's message page, where it sends a lookup it cannot answer. */
export function isLibertyMessagePage(location: string | null): boolean {
  try {
    const target = location ? new URL(location, `${LIBERTY_ORIGIN}/`) : null;
    return target?.origin === LIBERTY_ORIGIN && MESSAGE_PAGE.test(target.pathname);
  } catch {
    return false;
  }
}

/** A row's wall clock, to the second, with no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const parsed = match ? DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0) }, { zone: 'UTC' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Liberty Express returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The tracking page of one warehouse receipt: the current status and the
 * receipt above the history, newest first. Each row has its clock in the
 * `datetime` attribute and its status. The page names no zone, and its rows
 * come from the Doral warehouse and from Venezuela, so each keeps its wall clock.
 */
export function parseLiberty(html: string, raw: string): CarrierResult {
  const number = normalizeLibertyNumber(raw);
  const $ = load(html);
  const summary = $('section.tr-summary');
  const timeline = $('ol.tr-timeline');
  if (summary.length !== 1 || timeline.length !== 1) unexpected(html, 'Liberty Express returned a page without its tracking detail');
  const shown = clean(summary.find('p strong').first().text(), 64).toUpperCase();
  if (!RECEIPT.test(shown)) throw new SchemaError(PROVIDER, 'Liberty Express returned a page without its warehouse receipt');
  if (shown !== libertyReceipt(number)) throw new IndeterminateError(PROVIDER, 'Liberty Express answered for another warehouse receipt');

  const rows = timeline.children('li').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Liberty Express returned an oversized history');
  const listed: CarrierEvent[] = rows.map((row) => {
    const time = $(row).find('time');
    const description = clean($(row).find('h3').first().text(), 200);
    if (time.length !== 1 || !description) throw new SchemaError(PROVIDER, 'Liberty Express returned an incomplete scan');
    const stage = libertyStage(description);
    return { local_time: wallClock(clean(time.attr('datetime') ?? '', 40)), description,
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  });
  // Newest first, as the page lists them; rows that share a clock keep its order.
  const events = listed.map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.local_time === b.event.local_time ? a.index - b.index : String(a.event.local_time) < String(b.event.local_time) ? 1 : -1))
    .map(({ event }) => event);

  const newest = events[0];
  const current = clean(summary.find('h2').first().text(), 200);
  if (!newest) throw new NoHistoryError(PROVIDER, 'Liberty Express lists the warehouse receipt without a dated status', { reason: 'listed' });
  // The status above the history gives the stage when its wording maps to one, else the newest staged row does.
  const summed = current ? libertyStage(current) : null;
  const latest = events.find((event) => event.stage);
  const stage = summed?.stage ?? (latest?.stage as Stage | undefined);
  const source = summed?.source ?? latest?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: current || String(newest.description),
    last_update: null,
    last_update_local: String(newest.local_time),
    expected_delivery: null,
    events,
  };
}
