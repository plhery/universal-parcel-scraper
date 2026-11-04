import { load } from 'cheerio';
import { isFlickpostReference } from '../../core/detection/flickpost.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { flickpostStage } from './status.js';

export const PROVIDER = 'Flickpost';
export const FLICKPOST_MAX_BYTES = 1024 * 1024;
const BLOCKED = /_cf_chl_opt|challenge-platform|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|403 Forbidden/i;
const OTHER_FORMS = 'form#cf7-career-application-form, form#cf7-merchant-onboarding-form';
const DETAILS = new Set([
  'processing', 'awaiting sorting and bagging', 'outbound clearance in progress', 'en route to next facility',
  "en route to destination's port of entry", 'inbound for customs processing', 'shipping label created',
  'arrived at gofo regional hub', 'loaded on vehicle', 'departed gofo regional hub', 'in transit to next facility',
  'arrived at gofo delivery station', 'out for delivery', 'shipment created',
]);

export function normalizeFlickpostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Flickpost needs a shipment reference');
  if (!isFlickpostReference(number)) throw new NoHistoryError(PROVIDER, 'The dedicated lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function clock(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Flickpost returned an invalid scan clock');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00`;
}

function detail(value: string): string {
  if (DETAILS.has(value.toLowerCase())) return value;
  // Delivery support contacts follow this activity on the postal service. They are not scan details.
  return /^Delivered, Door\/Yard(?:\.|$)/.test(value) ? 'Delivered, Door/Yard' : '';
}

function location(value: string): string | undefined {
  if (value === 'Shah Alam Warehouse' || value === 'Kuala Lumpur, Malaysia'
    || /^[A-Z]{2,4}$/.test(value) || /^[\p{L}. '-]+, [A-Z]{2}$/u.test(value)) return value;
  return undefined;
}

/** Parse only the shortcode's shipment, never the page's hidden example or its unrelated forms. */
export function parseFlickpost(html: string, raw: string): CarrierResult {
  const number = normalizeFlickpostNumber(raw);
  if (new TextEncoder().encode(html).byteLength > FLICKPOST_MAX_BYTES) throw new SchemaError(PROVIDER, 'Flickpost returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Flickpost requires browser verification');
  const $ = load(html);
  const widgets = $('.g-recaptcha, iframe[src*="captcha"], input[name*="captcha"]').filter((_, el) => !$(el).closest(OTHER_FORMS).length);
  if (widgets.length) throw new ChallengeError(PROVIDER, 'Flickpost requires tracking verification');
  if ($('title').length !== 1 || clean($('title').text()) !== 'Track Parcel - Flickpost'
    || $('link[rel="canonical"]').length !== 1 || $('link[rel="canonical"]').attr('href') !== 'https://flickpost.com/tracking/'
    || $('form#track-form').length !== 1 || $('form#track-form input[name="trackingno"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'Flickpost returned no unique tracking page');
  }
  const scopes = $('.elementor-widget-shortcode').filter((_, el) => $(el).find('.full-accord, .tracking-results').length > 0);
  if (scopes.length !== 1) throw new SchemaError(PROVIDER, 'Flickpost returned no unique tracking result');
  const root = scopes.find('.full-accord'), errors = scopes.find('.tracking-results > .grid-col > p.invalid-text');
  if (errors.length) {
    const expected = `Invalid tracking number: Error occurred while tracking shipment ${number}. The tracking number was not found. Please enter a valid number`;
    if (errors.length === 1 && !root.length && errors.text().length <= 500 && clean(errors.text()) === expected) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Flickpost returned an unbound or mixed error reply');
  }
  if (root.length !== 1) throw new SchemaError(PROVIDER, 'Flickpost returned multiple shipments');
  const heading = root.children('button.result-accord'), panel = root.children('div.panel');
  const visible = heading.find('.track-col h3 > .ctc-inline-copy > .ctc-inline-copy-text');
  const copy = heading.find('.track-col h3 > .ctc-inline-copy > textarea.ctc-inline-copy-textarea');
  const summary = heading.find('.status-col .status-list > h4');
  if (heading.length !== 1 || panel.length !== 1 || clean(heading.find('.track-col > h6').text()) !== 'TRACKING NUMBER'
    || visible.length !== 1 || copy.length !== 1 || [visible.text(), copy.text()].some(value => value.length > 64 || normalizeTrackingNumber(value) !== number)
    || summary.length !== 1 || !summary.text().trim() || summary.text().length > 200) {
    throw new SchemaError(PROVIDER, 'Flickpost returned another shipment or changed its heading');
  }
  const facts = panel.find('.accord-box-content .accord-content-list > div');
  const labels = facts.toArray().map(el => clean($(el).children('p').text()));
  const values = facts.toArray().map(el => clean($(el).children('h5').text()));
  if (labels.join('|') !== 'SHIPMENT TYPE|SHIPPING OPTION|PARCEL WEIGHT'
    || facts.toArray().some(el => $(el).children('h5').length !== 1 || $(el).text().length > 200)
    || !/^(?:Non-document|Document)$/i.test(values[0]!) || !/^[A-Za-z0-9 ()+./-]{1,80}$/.test(values[1]!)) {
    throw new SchemaError(PROVIDER, 'Flickpost changed its forwarding service details');
  }
  const weight = /^(\d+(?:\.\d{1,3})?)\s*Kg$/i.exec(values[2]!);
  if (!weight || !Number.isFinite(Number(weight[1])) || Number(weight[1]) > 1_000_000) throw new SchemaError(PROVIDER, 'Flickpost returned an invalid parcel weight');
  const timelines = panel.find('.accord-box-timeline > .status-gap');
  const rows = timelines.children('.status-point');
  if (timelines.length !== 1 || rows.length > 500) throw new SchemaError(PROVIDER, 'Flickpost returned an invalid timeline');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Flickpost has no dated shipment history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let ownLeg = false, firstHeading = '';
  for (const [index, row] of rows.toArray().entries()) {
    const headings = $(row).children('h5'), cells = $(row).children('p');
    if (headings.length !== 1 || cells.length !== 3 || $(row).text().length > 2000 || !headings.text().trim() || headings.text().length > 200) {
      throw new SchemaError(PROVIDER, 'Flickpost returned a malformed scan');
    }
    const label = clean(headings.text()), place = clean(cells.eq(0).text()), activity = clean(cells.eq(1).text());
    if (index === 0) firstHeading = label;
    ownLeg ||= (label === 'Arrived At Hub' && place === 'KLG' && activity === 'Awaiting Sorting and Bagging')
      || (label === 'Progress' && place === 'Shah Alam Warehouse' && activity === 'Shipment created')
      || (label === 'Request Received' && place === 'Kuala Lumpur, Malaysia' && activity === 'Processing');
    const local = clock(clean(cells.eq(2).text())), extra = detail(activity), description = label + (extra ? ` — ${extra}` : '');
    const facility = location(place), stage = flickpostStage(description);
    const key = JSON.stringify([local, description, facility]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ local_time: local, description, ...(facility ? { location: facility } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!ownLeg) throw new IndeterminateError(PROVIDER, 'Flickpost did not show its own forwarding leg', { reason: 'unsupported_service' });
  if (normalizeStatusWording(clean(summary.text())) !== normalizeStatusWording(firstHeading)) throw new SchemaError(PROVIDER, 'Flickpost returned a contradictory current status');
  // Overseas and Malaysian scans have no offsets; preserve the portal's order, not a sort of mixed wall clocks.
  const newest = events[0]!, stage = flickpostStage(newest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    service_name: values[1]!, weight_kg: Number(weight[1]),
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
