import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { isText, type Element } from 'domhandler';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap, tlaStage } from './status.js';

export const PROVIDER = 'top-logistics-au';
/** The tracking frame Top Logistics' site search opens, with the number in `s`. */
export const TLA_LOOKUP = 'https://imshk.toplogistics.com.au/customerService/imparcelTracking';
// A delivered parcel's page is about 53 kB, most of it styles.
export const TLA_MAX_BYTES = 1024 * 1024;

// Letters and digits with at least one digit. The public sample is TPL and nine digits; the frame
// also matches other references.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracking frame. The frame's own head
// keeps a reCAPTCHA script commented out, so a bare mention of a CAPTCHA is not a block.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|class="(?:g-recaptcha|h-captcha)/i;
// The heading of the frame's history: "Details (Reference Number: TPL600042194)".
const REFERENCE = /^Details \(Reference Number: ([^()]{1,64})\)$/;
// A day's heading in the history: "13-05-2026 Wed".
const DAY = /^(\d{2})-(\d{2})-(\d{4}) (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;
// A scan under its day: "20:35 Shipment info received", or "N/A" for a scan without a time.
const SCAN = /^(?:([01]\d|2[0-3]):([0-5]\d)|N\/A) (.{1,300})$/;
// The courier's line under "Website to track": "ALLIED:".
const COURIER = /^([A-Za-z][\w .&'-]{0,40}):$/;
const MAX_SCANS = 300;

/** A number for the tracking frame: letters and digits with at least one digit, in capitals. */
export function normalizeTlaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Top Logistics Australia tracks references of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracking frame. */
export function isTlaBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * The courier the parcel was despatched to, from the lines under "Website to track": a name and a
 * link to the courier's site whose text is its number. The courier is named only when the frame
 * gives one line, the name or link is one catalog carrier's and that carrier's rules fit the number;
 * the number is kept when it differs from the one asked. The link is never followed.
 */
function courier($: CheerioAPI, body: Cheerio<Element>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const lines = body.children('a').toArray().map((link) => {
    const previous = link.prev;
    const name = previous && isText(previous) ? COURIER.exec(clean(previous.data, 60))?.[1] : undefined;
    return { name, url: clean($(link).attr('href'), 500), reference: normalizeTrackingNumber(clean($(link).text(), 64)).toUpperCase() };
  });
  if (lines.length !== 1) return {};
  const { name, url, reference } = lines[0]!;
  if (!name || !NUMBER.test(reference)) return {};
  const partner = carrierIdFromPartner(name, url);
  const fits = partner !== undefined && partner !== PROVIDER && (detectCarrierMatch(reference).candidates as readonly string[]).includes(partner);
  return {
    ...(fits ? { delivery_carrier: partner } : {}),
    ...(reference === number ? {} : { delivery_tracking_number: reference }),
  };
}

/** The scans under the history's day headings, oldest first, as the frame lists them, up to "Website to track". */
function scans($: CheerioAPI, body: Cheerio<Element>): CarrierEvent[] {
  const events: CarrierEvent[] = [];
  let day: string | null = null;
  for (const element of body.children('p.card-text').toArray()) {
    const line = clean($(element).text(), 400);
    if (line === 'Website to track') break;
    const heading = DAY.exec(line);
    if (heading) {
      day = calendarDay(Number(heading[3]), Number(heading[2]), Number(heading[1]))
        ?? invalid('Top Logistics Australia returned an invalid day');
      if (Number(heading[3]) < 2000) return invalid('Top Logistics Australia returned an invalid day');
      continue;
    }
    const row = SCAN.exec(line);
    if (!row || !day) return invalid('Top Logistics Australia returned an invalid scan');
    const description = clean(row[3], 300);
    const staged = tlaStage(description);
    events.push({
      // A scan without a time keeps its day.
      local_time: row[1] ? `${day}T${row[1]}:${row[2]}:00` : day,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
    if (events.length > MAX_SCANS) return invalid('Top Logistics Australia returned too many scans');
  }
  return events;
}

/**
 * The page of `imshk.toplogistics.com.au/customerService/imparcelTracking?s=<number>`, the frame
 * Top Logistics' site search opens. It names the parcel's reference, its route and an indicative
 * schedule, its most recent status, and its history: days, each with its scans, every scan on a
 * wall clock to the minute or without a time, oldest first. Under "Website to track" it names the
 * courier the parcel was despatched to with that courier's number. The page is rendered twice, for
 * wide and narrow screens; the wide one is read.
 *
 * The frame also matches other references and then shows another parcel, so the page must name
 * the number asked. The recipient's postcode, which the page's script holds, is never read.
 */
export function parseTla(body: string, raw: string): CarrierResult {
  const number = normalizeTlaNumber(raw);
  const $ = load(body);
  const cards = $('div.container-fluid.d-none.d-lg-block > div.card').toArray().map((card) => $(card));
  const details = cards.find((card) => REFERENCE.test(clean(card.children('div.card-header').text(), 120)));
  if (!details) return invalid('Top Logistics Australia returned a page without its history');
  const named = REFERENCE.exec(clean(details.children('div.card-header').text(), 120))![1]!;
  if (normalizeTrackingNumber(named).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Top Logistics Australia answered for another parcel');
  }
  const history = details.children('div.card-body');
  const handoff = courier($, history, number);
  // Newest first; scans of one day stay in the frame's order, turned round.
  const events = scans($, history).reverse();
  const newest = events[0];
  if (!newest) {
    throw new NoHistoryError(PROVIDER, 'Top Logistics Australia lists the parcel without scans', {
      reason: 'listed', deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number,
    });
  }
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...handoff,
    events,
  };
}
