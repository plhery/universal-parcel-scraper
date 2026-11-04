import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isRoyaleInternationalReference } from '../../core/detection/royaleInternational.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { royaleInternationalStage } from './status.js';

export const PROVIDER = 'Royale International';
export const ROYALE_MAX_BYTES = 1024 * 1024;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|verify (?:that )?you are human|403 Forbidden/i;

export function normalizeRoyaleInternationalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Royale International needs a shipment reference');
  if (!isRoyaleInternationalReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup needs a twelve-digit waybill', { reason: 'unsupported_reference' });
  return number;
}

function clock(date: string, time: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!day || !calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) {
    throw new SchemaError(PROVIDER, 'Royale International returned an invalid scan clock');
  }
  return `${date}T${time}`;
}

/** Read the visible SSR result, never embedded application data or recipient cells. */
export function parseRoyaleInternational(html: string, raw: string): CarrierResult {
  const number = normalizeRoyaleInternationalNumber(raw);
  if (new TextEncoder().encode(html).byteLength > ROYALE_MAX_BYTES) throw new SchemaError(PROVIDER, 'Royale International returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Royale International requires browser verification');
  const $ = load(html), root = $('section.tracking-page'), form = root.find('form.tracking-form');
  const input = form.find('input#waybillno[name="waybillno"]');
  if (root.length !== 1 || form.length !== 1 || form.attr('action') !== '/tracking' || form.attr('method')?.toLowerCase() !== 'get'
    || input.length !== 1 || form.find('.g-recaptcha, [name*="captcha"]').length) {
    if (form.find('.g-recaptcha, [name*="captcha"]').length) throw new ChallengeError(PROVIDER, 'Royale International requires tracking verification');
    throw new SchemaError(PROVIDER, 'Royale International returned no unique tracking page');
  }
  const identity = input.attr('value') ?? '';
  if (identity.length > 64 || (identity && normalizeTrackingNumber(identity) !== number)) throw new SchemaError(PROVIDER, 'Royale International returned another shipment');
  if (!root.find('table').length && !root.hasClass('tracking-page--results')) {
    throw new NoHistoryError(PROVIDER, 'Royale International has no available history', { reason: 'portal_not_found' });
  }
  if (!identity || !root.hasClass('tracking-page--results')) throw new SchemaError(PROVIDER, 'Royale International returned an unbound result');
  const table = (selector: string, headings: string, maxRows: number) => {
    const element = root.find(selector), header = element.find('thead tr');
    const rows = element.find('tbody tr');
    if (element.length !== 1 || header.length !== 1 || header.children('th').toArray().map(el => clean($(el).text())).join('|') !== headings
      || rows.length > maxRows) throw new SchemaError(PROVIDER, 'Royale International changed its tracking tables');
    return rows;
  };
  const details = table('table.details', 'Date|Shipper|Consignee|Services|Origin|Destination|Pieces|Reference', 1);
  if (details.length !== 1 || details.children('td').length !== 8) throw new SchemaError(PROVIDER, 'Royale International returned no unique shipment details');
  const service = clean(details.children('td').eq(3).text());
  if (service.length > 100) throw new SchemaError(PROVIDER, 'Royale International returned an invalid service');
  const proofRows = table('table.pod', 'Date|Time|Recipient|Details', 1);
  let proof: CarrierEvent | undefined;
  if (proofRows.length) {
    const cells = proofRows.children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Royale International changed its proof row');
    const date = clean(cells.eq(0).text()), time = clean(cells.eq(1).text());
    if (date || time) proof = { local_time: clock(date, time), description: 'Proof of delivery', stage: 'delivered', stage_source: 'carrier_map' };
  }
  const rows = table('table.events', 'Date|Time|Details', 500);
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Royale International returned no dated updates');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows.toArray().reverse()) {
    const cells = $(row).children('td');
    if (cells.length !== 3 || cells.eq(2).text().length > 2000) throw new SchemaError(PROVIDER, 'Royale International returned an invalid update');
    const description = clean(cells.eq(2).text()).split(/https?:\/\/|(?:recipient|phone)\s*:/i, 1)[0]!.trim();
    if (!description) throw new SchemaError(PROVIDER, 'Royale International returned no activity');
    const stage = royaleInternationalStage(description);
    const location = /^Checked in at (.{1,150} facility)$/i.exec(description)?.[1];
    const event: CarrierEvent = { local_time: clock(clean(cells.eq(0).text()), clean(cells.eq(1).text())), description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (proof) {
    // The portal lists proof separately. Its capture entry anchors it without sorting overseas wall clocks.
    const capture = events.findIndex(event => normalizeStatusWording(event.description!) === 'pod details captured'
      && event.local_time!.slice(0, 10) === proof.local_time!.slice(0, 10) && event.local_time! >= proof.local_time!);
    if (capture < 0) throw new SchemaError(PROVIDER, 'Royale International returned proof without its dated capture context');
    events.splice(capture + 1, 0, proof);
  }
  const newest = events[0]!;
  let stage = royaleInternationalStage(newest.description!);
  if (!stage && normalizeStatusWording(newest.description!) === 'pod details captured') {
    const previous = events.find(event => event.stage)?.stage;
    if (previous === 'in_transit' || previous === 'delivered') stage = previous;
  }
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(service ? { service_name: service } : {}), ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
