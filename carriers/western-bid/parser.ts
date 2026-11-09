import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { westernBidStage } from './status.js';

export const PROVIDER = 'Western Bid';
export const WESTERN_BID_PAGE = 'https://track.westparcel.com/';
export const WESTERN_BID_API = 'https://trackservice.wbapi.systems/api/track/currentStatus';
export const WESTERN_BID_MAX_BYTES = 1_000_000;
export const WESTERN_BID_READY = '.tracker-field, form.tracker-form + .w-form-fail';
const MISSING = 'We did not find a parcel with this number. It may not have been shipped yet, or the number may be incorrect.';
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

/** Explicit tracking can use a final-mile alias; the WBX rule stays unchanged. */
export function normalizeWesternBidNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'Western Bid needs an alphanumeric tracking number');
  return number;
}

export function westernBidTrackingUrl(raw: string): string {
  return `${WESTERN_BID_PAGE}?${new URLSearchParams({ trackNumber: normalizeWesternBidNumber(raw) })}`;
}

export function westernBidApiUrl(raw: string): string {
  return `${WESTERN_BID_API}?${new URLSearchParams({ trackingNumber: normalizeWesternBidNumber(raw) })}`;
}

export function validateWesternBidUrl(rawUrl: string, raw: string): void {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new TransportError(PROVIDER, 'Western Bid returned an invalid tracking address'); }
  if (url.origin !== new URL(WESTERN_BID_PAGE).origin || url.pathname !== '/' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(name => name !== 'trackNumber')) throw new TransportError(PROVIDER, 'Western Bid redirected its tracking page');
  if (url.searchParams.getAll('trackNumber').length !== 1 || url.searchParams.get('trackNumber') !== normalizeWesternBidNumber(raw)) {
    throw new IndeterminateError(PROVIDER, 'Western Bid returned another tracking query');
  }
}

function identity(text: string): string | null {
  if (text.length > 64) return null;
  const number = normalizeTrackingNumber(text);
  return /^[A-Z0-9]{4,40}$/.test(number) && /\d/.test(number) ? number : null;
}

/** The English client renders minute-resolution clocks without a stated offset. */
function wallClock(text: string): string {
  if (!/^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M$/.test(text)) throw new SchemaError(PROVIDER, 'Western Bid returned an invalid milestone clock');
  const date = DateTime.fromFormat(text, 'MM/dd/yyyy h:mm a', { zone: 'UTC', locale: 'en-US' });
  if (!date.isValid || date.year < 1000 || date.toFormat('MM/dd/yyyy h:mm a') !== text) throw new SchemaError(PROVIDER, 'Western Bid returned an invalid milestone day');
  // UTC checks the calendar only. The DOM supplies no offset to attach to it.
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The public result identifies both its WBX number and accepted final-mile aliases. */
export function parseWesternBid(html: string, raw: string, actualUrl: string): CarrierResult {
  const number = normalizeWesternBidNumber(raw);
  validateWesternBidUrl(actualUrl, number);
  if (new TextEncoder().encode(html).byteLength > WESTERN_BID_MAX_BYTES) throw new SchemaError(PROVIDER, 'Western Bid returned an oversized tracking page');
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Western Bid requires browser verification');
  const $ = load(html);
  const root = $('.tracker-field');
  if (root.length > 1) throw new IndeterminateError(PROVIDER, 'Western Bid returned several shipments');
  if (!root.length) {
    const form = $('form.tracker-form');
    if (form.length !== 1) throw new SchemaError(PROVIDER, 'Western Bid returned no unique tracking view');
    const fields = form.find('input[name="trackNumber"]');
    if (fields.length !== 1 || identity(fields.attr('value') ?? '') !== number) throw new IndeterminateError(PROVIDER, 'Western Bid did not confirm the requested query');
    const failure = form.next('.w-form-fail');
    if (failure.length !== 1) throw new IndeterminateError(PROVIDER, 'Western Bid has not completed its tracking lookup');
    const message = clean(failure.text(), 1000);
    if (message === MISSING) throw new NotFoundError(PROVIDER);
    if (/captcha|verif(?:y|ication)|browser check/i.test(message)) throw new ChallengeError(PROVIDER, 'Western Bid refused tracking verification');
    throw new IndeterminateError(PROVIDER, 'Western Bid did not complete its tracking lookup');
  }
  if ($('form.tracker-form').length) throw new SchemaError(PROVIDER, 'Western Bid returned conflicting tracking views');
  const block = root.children('.tracker-field_shiping-number');
  const canonicalField = block.children('div').first().children('p.paragraph-medium');
  if (block.length !== 1 || canonicalField.length !== 1) throw new SchemaError(PROVIDER, 'Western Bid returned no unique shipment identity');
  const canonical = identity(canonicalField.text());
  if (!canonical || !/^WBX\d{12}$/.test(canonical)) throw new IndeterminateError(PROVIDER, 'Western Bid did not identify an own-label shipment');
  const aliases: string[] = [];
  const aliasFields = block.children('div').eq(1).find('p.paragraph-medium > span.w-block');
  if (aliasFields.length > 30) throw new SchemaError(PROVIDER, 'Western Bid returned excessive related numbers');
  for (const field of aliasFields.toArray()) {
    const copy = $(field).clone(); copy.children().remove();
    const alias = identity(copy.text());
    if (!alias) throw new SchemaError(PROVIDER, 'Western Bid returned an invalid related number');
    aliases.push(alias);
  }
  const pic = uspsPackageIdentifier(number);
  if (canonical !== number && !aliases.some(alias => alias === number || (pic !== null && uspsPackageIdentifier(alias) === pic))) throw new IndeterminateError(PROVIDER, 'Western Bid answered for another shipment');
  const history = root.children('.tracker-field-etaps');
  const steppers = history.children('.MuiStepper-root');
  if (history.length !== 1 || steppers.length !== 1) throw new SchemaError(PROVIDER, 'Western Bid returned no unique milestone view');
  const rows = steppers.children('.MuiStep-root');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Western Bid returned too many milestones');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const content = $(row).find('.MuiStepLabel-label p.paragraph-small');
    if (content.length !== 1) throw new SchemaError(PROVIDER, 'Western Bid changed its milestone layout');
    if (content.hasClass('is--future') || (!content.hasClass('is--past') && !content.hasClass('is--now'))) continue;
    const breaks = content.children('br');
    // A completed but undated rail label is not a scan.
    if (!breaks.length) continue;
    if (breaks.length !== 1 || content.children().length !== 1) throw new SchemaError(PROVIDER, 'Western Bid changed its milestone clock layout');
    let before = '', after = '', passed = false;
    for (const node of content.contents().toArray()) {
      if (node === breaks[0]) { passed = true; continue; }
      if (passed) after += $(node).text(); else before += $(node).text();
    }
    const description = clean(before, 500);
    if (!description) throw new SchemaError(PROVIDER, 'Western Bid returned an unnamed milestone');
    const local = wallClock(after.trim());
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = westernBidStage(description);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const current = events.find(event => event.stage);
  return {
    status: current?.stage ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current?.stage ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: events[0]!.description!, last_update: null, last_update_local: events[0]!.local_time!,
    ...(canonical !== number ? { canonical_tracking_number: canonical } : {}),
    expected_delivery: null, history_truncated: true, events,
  };
}
