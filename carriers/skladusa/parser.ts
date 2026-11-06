import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isSkladusaReference } from '../../core/detection/skladusa.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { projectSkladusaStatus, type SkladusaStatus } from './status.js';

export const PROVIDER = 'SkladUSA';
export const MAX_BYTES = 1024 * 1024;
const ORIGIN = 'https://skladusa.com';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const HIDDEN = '[hidden],[aria-hidden="true"],.hide,.hidden,.d-none,[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]';
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function normalizeSkladusaNumber(raw: string): string {
  if (!isSkladusaReference(raw)) throw new InvalidInputError(PROVIDER, 'SkladUSA needs its whole system tracking number');
  return normalizeTrackingNumber(raw);
}

export function skladusaTrackingUrl(raw: string): string {
  return ORIGIN + '/en/tracking/' + normalizeSkladusaNumber(raw).toLowerCase() + '/';
}

/** Only the observed language/canonical redirects may retain the same guest lookup. */
export function isSkladusaTrackingRoute(raw: string, number: string, final = false): boolean {
  const suffix = normalizeSkladusaNumber(number).toLowerCase();
  return ['', '/en'].some(prefix => raw === `${ORIGIN}${prefix}/tracking/${suffix}/`
    || (!final && raw === `${ORIGIN}${prefix}/tracking/${suffix}`));
}

export function assertSkladusaGuestHtml(html: string): void {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|["'](?:challenge-form|cf-challenge-running)["']|>\s*Verify (?:that )?you are human|class=["'][^"']*\b(?:g-recaptcha|h-captcha)\b/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'SkladUSA returned browser verification');
  }
}

function clock(value: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const year = Number(match?.[3]);
  const day = match && year >= 2000 && year <= 2100 ? calendarDay(year, Number(match[2]), Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'SkladUSA returned an invalid scan clock');
  return day + 'T' + match[4] + ':' + match[5];
}

function sameRoute(raw: string | undefined, expected: string, relative: boolean): boolean {
  if (!raw || raw.length > 512 || raw !== raw.trim() || (!relative && !raw.startsWith(ORIGIN + '/'))) return false;
  try {
    const url = new URL(raw, ORIGIN);
    return !url.username && !url.password && !url.search && !url.hash && url.href === expected;
  } catch { return false; }
}

/** The scoped guest reply is bound by route and both responsive identities, not by an independent record id. */
export function parseSkladusaTrackingHtml(html: string, raw: string, responseUrl = skladusaTrackingUrl(raw)): CarrierResult {
  const number = normalizeSkladusaNumber(raw), expected = responseUrl;
  if (!isSkladusaTrackingRoute(expected, number, true)) throw new SchemaError(PROVIDER, 'SkladUSA returned another tracking route');
  const ukrainian = !expected.startsWith(ORIGIN + '/en/');
  if (html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) {
    throw new SchemaError(PROVIDER, 'SkladUSA returned too much tracking data');
  }
  assertSkladusaGuestHtml(html);
  const $ = load(html); $('script,style,template').remove();
  const canonical = $('link[rel="canonical"]'), pageUrls = $('[data-pageurl]');
  if (canonical.length !== 1 || pageUrls.length > 1 || !sameRoute(canonical.attr('href'), expected, false)
    || (pageUrls.length && !sameRoute(pageUrls.attr('data-pageurl'), expected, true))) {
    throw new SchemaError(PROVIDER, 'SkladUSA returned an unrelated or ambiguous tracking route');
  }
  const panels = $('.tracking-result'), notices = $('.help-block.not-found');
  const hidden = (elements: typeof panels): boolean => Boolean(elements.closest(HIDDEN).length || elements.find(HIDDEN).length
    || elements.add(elements.parents()).add(elements.find('[style]')).filter((_, element) =>
      /(?:display:none|visibility:hidden)/.test(($(element).attr('style') ?? '').replace(/\s+/g, '').toLowerCase())).length);
  const statusText = (elements: typeof panels): string => {
    const copy = elements.clone(); copy.find('svg').remove(); return compact(copy.text());
  };
  const foundHeadings = $('h1').filter((_, element) => /^(?:Search result|Результат пошуку):/iu.test(compact($(element).text())));
  if (notices.length) {
    if (notices.length === 1 && compact(notices.text()) === (ukrainian ? 'Ще немає інформації про відстеження' : 'No tracking info yet') && !hidden(notices)
      && !panels.length && !foundHeadings.length && !$('table').length) {
      throw new NoHistoryError(PROVIDER, 'SkladUSA returned no retained tracking history', { reason: 'expired_or_unknown' });
    }
    throw new SchemaError(PROVIDER, 'SkladUSA returned a mixed or malformed empty result');
  }
  const desktop = $('.search-table.search-statuses'), mobile = $('.search-mobile.search-statuses');
  if (panels.length !== 1 || hidden(panels)
    || desktop.length !== 1 || mobile.length !== 1 || panels.children().length !== 2
    || !desktop.parent().is(panels) || !mobile.parent().is(panels) || $('.search-statuses').length !== 2) {
    throw new SchemaError(PROVIDER, 'SkladUSA returned unrelated or hidden result panels');
  }
  const heading = desktop.children('h1'), mobileHeading = mobile.children('h1');
  const matchesHeading = (value: string, prefix: string): boolean => {
    const text = compact(value);
    return text.toUpperCase() === prefix.toUpperCase() + number;
  };
  if (heading.length !== 1 || mobileHeading.length !== 1 || foundHeadings.length !== 2
    || !matchesHeading(heading.text(), ukrainian ? 'Результат пошуку: ' : 'Search result: ') || !matchesHeading(mobileHeading.text(), 'Результат пошуку: ')
    || heading.children('span').length !== 1 || mobileHeading.children('span').length !== 1
    || compact(heading.children('span').text()).toUpperCase() !== number
    || compact(mobileHeading.children('span').text()).toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'SkladUSA returned no matching whole responsive identities');
  }
  const table = desktop.children('table.search-table__table'), tableRows = table.find('tr');
  const headers = tableRows.first().children('th'), rows = tableRows.slice(1);
  if (table.length !== 1 || $('table').length !== 1 || desktop.children().length !== 2
    || table.find('table').length || headers.length !== 3 || tableRows.first().children().length !== 3
    || JSON.stringify(headers.map((_, element) => compact($(element).text())).get())
      !== JSON.stringify(ukrainian ? ['Дата', 'Статус', 'Детальніше'] : ['Data', 'Status', 'More details'])
    || rows.length > MAX_ROWS || table.find('th').length !== 3) {
    throw new SchemaError(PROVIDER, 'SkladUSA changed its tracking table');
  }
  const mobileList = mobile.children('.search-mobile__items'), mobileRows = mobileList.children('.search-mobile__item');
  if (mobileList.length !== 1 || mobile.children().length !== 2 || mobileList.children().length !== rows.length
    || mobileRows.length !== rows.length || $('.search-mobile__item').length !== rows.length) {
    throw new SchemaError(PROVIDER, 'SkladUSA returned a different responsive history');
  }
  const scans: { local: string; status: SkladusaStatus }[] = [];
  let partial = false;
  for (const [index, row] of rows.toArray().entries()) {
    const cells = $(row).children('td'), label = cells.eq(1).children('span.status-no-info');
    if (cells.length !== 3 || $(row).children().length !== 3 || label.length !== 1 || label.children().not('svg').length
      || cells.eq(0).children().length || cells.eq(1).children().not('span,svg').length) {
      throw new SchemaError(PROVIDER, 'SkladUSA changed a scan row');
    }
    const date = compact(cells.eq(0).text()), wording = statusText(label), details = compact(cells.eq(2).text());
    const leftover = cells.eq(1).clone(); leftover.children('span,svg').remove();
    if (!wording || wording.length > 1000 || details.length > 2000 || compact(leftover.text())) {
      throw new SchemaError(PROVIDER, 'SkladUSA returned an invalid scan description');
    }
    const mobileRow = mobileRows.eq(index), top = mobileRow.children('.search-mobile__top');
    const mobileDate = top.children('.search-mobile__date'), mobileStatus = top.children('.search-mobile__status');
    const mobileLabel = mobileStatus.children('span.status-no-info'), mobileDetails = mobileRow.children('.search-mobile__txt');
    if (mobileRow.children().length !== 2 || top.length !== 1 || top.children().length !== 2 || mobileDate.length !== 1
      || mobileStatus.length !== 1 || mobileLabel.length !== 1 || mobileLabel.children().not('svg').length || mobileStatus.children().length !== 1
      || mobileDetails.length !== 1 || compact(mobileDate.text()) !== date || statusText(mobileLabel) !== wording
      || compact(mobileDetails.text()) !== details) {
      throw new SchemaError(PROVIDER, 'SkladUSA returned contradictory responsive scan rows');
    }
    const local = clock(date), status = projectSkladusaStatus(wording);
    if (status.partial) partial = true;
    scans.push({ local, status });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'SkladUSA returned no retained tracking history', { reason: 'expired_or_unknown' });
  // The provider's newest-first sequence is authoritative across unoffset international clocks.
  // Validate both full source views before stable deduplication and the output cap.
  const seenScans = new Set<string>();
  const distinct = scans.filter(scan => {
    const key = JSON.stringify([scan.local, scan.status.description, Boolean(scan.status.delivery)]);
    if (seenScans.has(key)) return false; seenScans.add(key); return true;
  });
  const events: CarrierEvent[] = [], seenEvents = new Set<string>();
  for (const [index, scan] of distinct.entries()) {
    const previous = distinct[index + 1];
    const provedDelivery = scan.status.delivery && index === 0 && previous?.status.lastMile;
    const status: SkladusaStatus = scan.status.delivery && !provedDelivery ? { description: 'Tracking update', partial: true } : scan.status;
    if (status.partial) partial = true;
    const event: CarrierEvent = { local_time: scan.local, description: status.description,
      ...(status.stage ? { stage: status.stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seenEvents.has(key)) { seenEvents.add(key); events.push(event); }
  }
  const newest = events[0]!, stage = projectSkladusaStatus(newest.description!).stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(partial || events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
