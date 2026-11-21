import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, canadaProvinceTimeZone, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { vitranStage } from './status.js';

export const PROVIDER = 'Vitran Express';
export const VITRAN_ORIGIN = 'https://www.vitran.com';
/** The Quick Track page, which looks up the PRO bill number its `p` parameter names. */
export const VITRAN_QUICK_TRACK = `${VITRAN_ORIGIN}/quicktrack.aspx`;
// The page is about 33 kB, most of it the site's header, menu and footer.
export const VITRAN_MAX_BYTES = 512 * 1024;

// The Quick Track box takes digits, up to twenty.
const NUMBER = /^\d{4,20}$/;
// A day as the page prints it, month first: "04/10/2025".
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// A weight as the page prints it: "160lbs".
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?)\s*(lbs?|kgs?)\.?$/i;
// A city as the page prints it, with its province or state: "QUEBEC, QC".
const REGION = /,\s*([A-Z]{2})$/;
// The label the page could put before a delivery estimate.
const ESTIMATE_LABEL = /estimat|\bETA\b|expected/i;
// The page's answer for a number it holds nothing for.
const NOT_FOUND = /^Not found\.?$/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
const POUNDS_TO_KG = 0.453_592_37;

/** A Vitran PRO bill number: digits, as the Quick Track box takes them. */
export function normalizeVitranNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Vitran PRO bill numbers are digits, up to twenty');
  return number;
}

/** The Quick Track address for one PRO bill number. */
export function vitranQuickTrackUrl(number: string): string {
  return `${VITRAN_QUICK_TRACK}?p=${encodeURIComponent(number)}`;
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isVitranChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isVitranChallenge(html)) throw new ChallengeError(PROVIDER, 'Vitran answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The number the page's form posts back to, from its `p` parameter, or '' for none. */
function formNumber(form: Cheerio<Element>): string {
  try {
    const action = new URL(form.attr('action') ?? '', `${VITRAN_ORIGIN}/`);
    return /^\/quicktrack\.aspx$/i.test(action.pathname) ? clean(action.searchParams.get('p'), 64) : '';
  } catch {
    return '';
  }
}

/** One labelled value of the answer, '' when the page leaves it out. Two of one is a changed page. */
function field($: CheerioAPI, panel: Cheerio<Element>, id: string, html: string): string {
  const found = panel.find(`span#${id}`);
  if (found.length > 1) unexpected(html, 'Vitran returned an answer with a repeated field');
  return found.length ? clean($(found[0]).text(), 200) : '';
}

/** A day the page prints month first, as a calendar day, or null. */
function localDay(text: string): string | null {
  const parts = DAY.exec(text);
  return parts ? calendarDay(Number(parts[3]), Number(parts[1]), Number(parts[2])) : null;
}

/** A dated field's day; text that is not a day is kept as printed. */
function dayOf(text: string): Pick<CarrierEvent, 'local_time'> | { provider_time_text: string } {
  const day = localDay(text);
  return day ? { local_time: day } : { provider_time_text: clean(text, 60) };
}

/** The weight in kilograms, from pounds or kilograms; null for none or another unit. */
function weightOf(text: string): number | null {
  const parts = WEIGHT.exec(text);
  const value = Number(parts?.[1]);
  if (!parts || !Number.isFinite(value) || value <= 0) return null;
  const kg = parts[2]!.toLowerCase().startsWith('lb') ? value * POUNDS_TO_KG : value;
  return Math.round(kg * 1000) / 1000;
}

/** The country of a city the page prints with a Canadian province or a US state, or null. */
function countryOf(city: string): string | null {
  const region = REGION.exec(city)?.[1];
  if (!region) return null;
  return canadaProvinceTimeZone(region) ? 'CA' : usStateTimeZone(region) ? 'US' : null;
}

/** A dated milestone of the answer, staged by its wording. */
function milestone(text: string, place: string, description: string): CarrierEvent {
  const stage = vitranStage(description);
  return {
    ...dayOf(text), ...(place ? { location: place } : {}), description,
    ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
  };
}

/**
 * The answer `quicktrack.aspx?p={number}` renders on the server for one PRO
 * bill: the current status, the PRO number, the pieces and weight, the origin
 * and destination cities, the pickup day, an estimate while the shipment
 * travels and the delivery day. There is no scan history: the events are the
 * pickup, and the delivery once the status says so, each dated by its day
 * alone. A number the page holds nothing for gets "Not found." beside the
 * form, which posts back to that number. The answer must name the number asked.
 */
export function parseVitran(html: string, raw: string): CarrierResult {
  const number = normalizeVitranNumber(raw);
  const $ = load(html);
  const form = $('form#form1');
  const panel = $('div#Main_PNL_quiktrack');
  const notice = $('span#Main_Lbl_notvalid');
  if (form.length !== 1 || panel.length > 1 || notice.length > 1) unexpected(html, 'Vitran returned a page without its quick track form');
  const message = clean(notice.text(), 200);

  if (!panel.length) {
    if (!NOT_FOUND.test(message)) {
      if (message) throw new IndeterminateError(PROVIDER, 'Vitran answered with a notice the adapter does not know');
      unexpected(html, 'Vitran returned a page without its quick track answer');
    }
    if (formNumber(form) !== number) throw new IndeterminateError(PROVIDER, 'Vitran answered for another PRO bill');
    throw new NotFoundError(PROVIDER);
  }
  if (message) unexpected(html, 'Vitran returned an answer beside a notice');

  const value = (id: string) => field($, panel, id, html);
  const shown = value('Main_Lbl_pronumber');
  if (!shown) unexpected(html, 'Vitran returned an answer without its PRO number');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Vitran answered for another PRO bill');

  const status = value('Main_Lbl_status');
  const origin = value('Main_Lbl_shipper');
  const destination = value('Main_Lbl_Dest');
  const pickup = value('Main_Lbl_pickupdate');
  const estimateLabel = value('Main_Label10');
  const estimateText = value('Main_Label11');
  const deliveryText = value('Main_lbl_Del');

  const summed = status ? vitranStage(status) : null;
  const delivered = summed?.stage === 'delivered';
  // The page lists the pickup, then the delivery. The delivery day counts once the status says so.
  const listed: CarrierEvent[] = [
    ...(pickup ? [milestone(pickup, origin, 'Picked Up')] : []),
    ...(delivered && deliveryText ? [milestone(deliveryText, destination, 'Delivered')] : []),
  ];
  // A milestone without a readable day keeps the place of the one before it.
  let previous = '';
  const keyed = listed.map((event) => {
    previous = typeof event.local_time === 'string' ? event.local_time : previous;
    return { event, key: previous };
  });
  // Newest first; milestones on one day keep the page's order, the delivery above the pickup.
  const events = [...keyed].reverse().sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? 1 : -1)).map(({ event }) => event);

  const newest = events[0];
  if (!status && !newest) throw new NoHistoryError(PROVIDER, 'Vitran lists the PRO bill without a status or a day', { reason: 'listed' });
  const latest = events.find((event) => event.stage);
  const stage = summed?.stage ?? (latest?.stage as Stage | undefined);
  const source = summed?.source ?? latest?.stage_source;

  // An estimate stands only while the shipment travels, under a label that names one.
  const estimate = !delivered && ESTIMATE_LABEL.test(estimateLabel) ? localDay(estimateText) : null;
  const weight = weightOf(value('Main_Lbl_weight'));
  const country = countryOf(destination);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: status || null,
    last_update: null,
    ...(typeof newest?.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: estimate,
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(country ? { destination_country: country } : {}),
    // A delivery day before the status says delivered, or an estimate the adapter cannot read, is named for a capture.
    ...unreadEstimates({ Main_Label11: estimate || delivered ? null : estimateText, Main_lbl_Del: delivered ? null : deliveryText }),
    summary_only: true,
    events,
  };
}
