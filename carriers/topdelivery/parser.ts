import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isTopdeliveryReference } from '../../core/detection/topdelivery.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { topdeliveryStage } from './status.js';

export const PROVIDER = 'TopDelivery';
export const TOPDELIVERY_MAX_BYTES = 1024 * 1024;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|403 Forbidden/i;

export function normalizeTopdeliveryNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'TopDelivery needs an order reference');
  if (!isTopdeliveryReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function clock(date: string, time: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day) throw new SchemaError(PROVIDER, 'TopDelivery returned an invalid scan day');
  if (!time) return day;
  const parts = /^\(((?:[01]\d|2[0-3]):[0-5]\d)\)$/.exec(time);
  if (!parts) throw new SchemaError(PROVIDER, 'TopDelivery returned an invalid scan clock');
  return `${day}T${parts[1]}:00`;
}

export function parseTopdelivery(html: string, raw: string): CarrierResult {
  const number = normalizeTopdeliveryNumber(raw);
  if (new TextEncoder().encode(html).byteLength > TOPDELIVERY_MAX_BYTES) throw new SchemaError(PROVIDER, 'TopDelivery returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'TopDelivery requires browser verification');
  const $ = load(html), form = $('form.header-status__form[action="/tracking/#result"]'), input = form.find('input#order[name="order"]');
  if (form.find('.g-recaptcha, [name*="captcha"]').length) throw new ChallengeError(PROVIDER, 'TopDelivery requires tracking verification');
  const identity = input.attr('value') ?? '';
  if ($('title').length !== 1 || clean($('title').text()) !== 'Отслеживание заказа - topdelivery.ru'
    || form.length !== 1 || input.length !== 1 || identity.length > 64 || normalizeTrackingNumber(identity) !== number) {
    throw new SchemaError(PROVIDER, 'TopDelivery returned an unbound tracking page');
  }
  const root = $('.container.info'), error = $('section.container.error > .tracking__text');
  if (error.length) {
    const first = error.contents().first().text().trim();
    if (error.length === 1 && !root.length && first === 'Ваш заказ не найден.') throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'TopDelivery returned a mixed or changed error view');
  }
  const own = $('#order-cancel-form input[name="orderId"]'), ownIdentity = own.attr('value') ?? '';
  if (root.length !== 1 || root.children('.info-status').length !== 1 || root.children('.info-details').length !== 1
    || own.length !== 1 || ownIdentity.length > 64 || normalizeTrackingNumber(ownIdentity) !== number) {
    throw new SchemaError(PROVIDER, 'TopDelivery returned another order or changed its result');
  }
  // Only read the order identity from this form; its controls and access token are never used.
  const timeline = root.find('.info-status > ul'), rows = timeline.children('li');
  if (timeline.length !== 1 || rows.length > 500) throw new SchemaError(PROVIDER, 'TopDelivery returned an invalid timeline');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows.toArray().reverse()) {
    const item = $(row), date = item.children('.info-status__item-data'), time = date.children('.info-status__item-time');
    if (!item.hasClass('active-status')) {
      if (date.text().trim()) throw new SchemaError(PROVIDER, 'TopDelivery dated an inactive timeline step');
      continue;
    }
    const label = item.children('span');
    if (label.length !== 1 || date.length !== 1 || time.length !== 1 || label.text().length > 500) throw new SchemaError(PROVIDER, 'TopDelivery returned a malformed scan');
    const copy = label.clone(); copy.find('br').replaceWith(' ');
    const description = clean(copy.text()), day = date.clone(); day.children('.info-status__item-time').remove();
    if (!description) throw new SchemaError(PROVIDER, 'TopDelivery returned a scan without its wording');
    const stage = topdeliveryStage(description);
    const event: CarrierEvent = { local_time: clock(clean(day.text()), clean(time.text())), description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'TopDelivery returned no dated history');
  const newest = events[0]!, stage = topdeliveryStage(newest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
