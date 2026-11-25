/**
 * The courier site TSS Smart (tsssmart.com) builds for UAE couriers: FyNEX's, MAX Express's and
 * DDU Express's tracking pages run it, each on its own host. The page takes the number as
 * `trackno`, by POST from its form or in its address, and renders the answer on the server in a
 * `tracking-panel` block: "Tracking Number: {number}", a summary of the route and current status,
 * a table of dated scans newest first, and the shipment type, weight and pieces. For a number it
 * does not know, MAX Express's and DDU Express's panels say "Invalid airwaybill or booking
 * number"; FyNEX's stays empty, as it does when the page gets no number at all. Each carrier keeps
 * its own host, numbers and status map; this module holds the request and parser they share.
 */
import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** One carrier's site on the TSS Smart build. */
export interface TssSmartSite {
  /** The catalog id, which errors also carry. */
  readonly carrier: string;
  /** The carrier's name in messages. */
  readonly name: string;
  /** The tracking page, such as `https://example.ae/tracking/`. */
  readonly tracker: string;
  /** The carrier's numbers, as normalization leaves them. */
  readonly layout: RegExp;
  /** What a number of another layout is told. */
  readonly layoutMessage: string;
  /** A scan's stage by its wording. */
  readonly stage: (wording: string) => ClassifiedWording | null;
  readonly statusMap: CarrierStatusMap;
}

// The whole page with a shipment is about 220 kB, most of it the theme's markup.
export const TSS_SMART_MAX_BYTES = 2 * 1024 * 1024;
// The panel's answer for a number the carrier holds no shipment under.
export const TSS_SMART_UNKNOWN = /^Invalid airwaybill or booking number\.?$/i;
const REDIRECTS = [301, 302, 303, 307, 308];
const HTML_TYPE = /^text\/html\b/i;
// A firewall's, CDN's or bot check's page in place of the tracking page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden|Captcha)|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|sgcaptcha|imunify360-webshield|Please wait while your request is being verified/i;
const ECHO = /^Tracking Number:\s*(\S{1,64})$/i;
// "09 Oct 2025" and "08:04 PM"
const DAY = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;
const CLOCK = /^(0?[1-9]|1[0-2]):([0-5]\d) ?([AP]M)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEIGHT = /^(\d{1,5}(?:\.\d{1,3})?) ?(?:kgs?|kilograms?)$/i;
// A delivery scan goes on to say who took the parcel: "Shipment Delivered Received By {name}".
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:received|signed|collected)\s+by\b.*$/i;
const MAX_ROWS = 300;

/** A site's number, as the adapter asks for it; anything else is not one of its numbers. */
export function normalizeTssSmartNumber(raw: string, site: TssSmartSite): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!site.layout.test(number)) throw new InvalidInputError(site.carrier, site.layoutMessage);
  return number;
}

/** Whether a reply is a block page instead of the tracking page. */
export function isTssSmartBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

function text($: CheerioAPI, element: Cheerio<AnyNode> | AnyNode, maxLength = 300): string {
  return clean($(element).text(), maxLength);
}

/** A scan's day and 12-hour clock as one wall clock. The page names no zone. */
function wallClock(day: string, minute: string, site: TssSmartSite): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(minute);
  const month = date ? MONTHS.indexOf(date[2]!.toLowerCase()) + 1 : 0;
  const valid = date && month ? calendarDay(Number(date[3]), month, Number(date[1])) : null;
  if (!valid || valid < '2000-01-01' || !clock) throw new SchemaError(site.carrier, `${site.name} returned an invalid scan time`);
  const hour = Number(clock[1]) % 12 + (clock[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${valid}T${String(hour).padStart(2, '0')}:${clock[2]}:00`;
}

/** The scan table's rows: the day with its clock under it, the place and the activity. */
function scans($: CheerioAPI, panel: Cheerio<AnyNode>, site: TssSmartSite): CarrierEvent[] {
  const tables = panel.find('table.status-table');
  if (tables.length > 1) throw new SchemaError(site.carrier, `${site.name} returned several scan tables`);
  const rows = tables.find('tr').toArray().filter((row) => $(row).children('td').length);
  if (rows.length > MAX_ROWS) throw new SchemaError(site.carrier, `${site.name} returned an oversized history`);
  const seen = new Set<string>();
  const events: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    const cells = $(row).children('td');
    if (cells.length < 3) throw new SchemaError(site.carrier, `${site.name} returned an incomplete scan`);
    const when = cells.eq(0);
    const minute = text($, when.find('.second-line'), 20);
    when.find('.second-line').remove();
    const local = wallClock(text($, when, 30), minute, site);
    // Who took a delivered parcel is never read.
    const description = text($, cells.eq(2), 200).replace(RECEIVER, '').trim();
    if (!description) throw new SchemaError(site.carrier, `${site.name} returned a scan without its activity`);
    const location = text($, cells.eq(1), 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = site.stage(description);
    events.push({ local, index, event: {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; of scans on one minute, the row higher in the table is the newer.
  events.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  return events.map((scan) => scan.event);
}

/** The destination's country, from the summary's "To" cell. */
function destination($: CheerioAPI, panel: Cheerio<AnyNode>): string | null {
  const summary = panel.find('table').not('.status-table').first();
  const headings = summary.find('th').toArray().map((element) => text($, element, 40).toLowerCase());
  const to = headings.indexOf('to');
  if (to < 0) return null;
  const cell = summary.find('tbody tr').first().children('td').eq(to);
  return countryCode(text($, cell.find('.from-country, .to-country').first(), 80));
}

/** The details table's value under a heading. */
function detail($: CheerioAPI, panel: Cheerio<AnyNode>, heading: string): string {
  for (const table of panel.find('table').not('.status-table').toArray()) {
    const rows = $(table).find('tr').toArray();
    const headings = rows[0] ? $(rows[0]).children('th').toArray().map((element) => text($, element, 40).toLowerCase()) : [];
    const index = headings.indexOf(heading);
    if (index >= 0 && rows[1]) return text($, $(rows[1]).children('td').eq(index), 80);
  }
  return '';
}

/**
 * The tracking page's answer for one number. The panel must name the number asked. The shipper,
 * the consignee and who signed for a delivery are never read; the page names neither of the first
 * two, and a delivery scan's receiver is cut from its wording.
 */
export function parseTssSmart(html: string, raw: string, site: TssSmartSite): CarrierResult {
  const number = normalizeTssSmartNumber(raw, site);
  const $ = load(html);
  const panels = $('.tracking-panel');
  if (panels.length !== 1) {
    if (isTssSmartBlocked(html)) throw new ChallengeError(site.carrier, `${site.name} answered with a bot check`);
    throw new SchemaError(site.carrier, `${site.name} answered with a page that is not its tracking page`);
  }
  const panel = panels.first();
  const heading = panel.find('.tracking-number');
  if (!heading.length) {
    if (panel.find('.alert').toArray().some((element) => TSS_SMART_UNKNOWN.test(text($, element)))) {
      throw new NotFoundError(site.carrier, `${site.name} has no shipment under this number`);
    }
    // FyNEX's page shows an empty panel both for a number it does not know and for no number.
    if (!text($, panel)) throw new IndeterminateError(site.carrier, `${site.name} showed nothing for the number`);
    throw new SchemaError(site.carrier, `${site.name} returned an unexpected tracking panel`);
  }
  if (heading.length > 1) throw new IndeterminateError(site.carrier, `${site.name} answered for several shipments`);
  const echoed = ECHO.exec(text($, heading, 100))?.[1];
  if (!echoed) throw new SchemaError(site.carrier, `${site.name} returned a panel without its tracking number`);
  if (normalizeTrackingNumber(echoed).toUpperCase() !== number) {
    throw new IndeterminateError(site.carrier, `${site.name} answered for another number`);
  }
  const events = scans($, panel, site);
  if (!events.length) throw new NoHistoryError(site.carrier);
  const lead = leadingScan(events, site.statusMap);
  const stage = lead?.stage as Stage | undefined;
  const country = destination($, panel);
  const service = detail($, panel, 'shipment type');
  const weight = WEIGHT.exec(detail($, panel, 'weight'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight && Number(weight[1]) > 0 ? { weight_kg: Number(weight[1]) } : {}),
    events,
  };
}

/** Looks a site's number up on its tracking page, posting it as the page's form does. */
export class TssSmartTracker {
  constructor(
    private readonly site: TssSmartSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  /** The form post the tracking page makes. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { site } = this;
    const { origin } = new URL(site.tracker);
    const { response, bytes } = await fetchBounded(site.tracker, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: site.tracker,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ trackno: number }).toString() }, {
      provider: site.carrier, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TSS_SMART_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isTssSmartBlocked(body)) throw new ChallengeError(site.carrier, `${site.name} answered with a browser check`, { status });
      if (status !== 503) throw new ChallengeError(site.carrier, `${site.name} refused the lookup`, { status });
      throw new MaintenanceError(site.carrier, undefined, { status });
    }
    // The page answers every number with HTTP 200; a redirect or a missing page is a moved tracker.
    if (status !== 200) throw new TransportError(site.carrier, `${site.name} tracking is unavailable`, { status });
    if (!HTML_TYPE.test(response.headers.get('content-type') ?? '')) {
      throw new SchemaError(site.carrier, `${site.name} answered with something other than its tracking page`);
    }
    return parseTssSmart(body, number, site);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTssSmartNumber(raw, this.site);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a page is never sent again. The page can take several
    // seconds to render a shipment.
    return runSteps({ carrier: this.site.carrier, budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
