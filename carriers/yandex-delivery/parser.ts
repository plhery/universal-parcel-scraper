import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, yandexDeliveryStage } from './status.js';

export const PROVIDER = 'Yandex Delivery';
export const YANDEX_DELIVERY_URL = 'https://dostavka.yandex.ru/ndd/tracking/';
export const YANDEX_DELIVERY_MAX_BYTES = 1024 * 1024;

const MAX_ROWS = 500;
const CHALLENGE = /showcaptcha|smartcaptcha|captcha-page|<title>\s*(?:Ой!|Oops!|Are you not a robot)/i;
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;
// A scan whose line under the wording is a note rather than a place: a storage deadline, a new
// return date or the reason of a cancellation.
const DETAIL_WORDING = /^(?:ждёт вручения|ждет вручения|изменён|изменен|отмен)/i;
const DETAIL_LINE = /^(?:срок хранения|до \d|на \d|истек)/i;

/** A tracking or order number as the page's form takes it: 6 to 40 Latin letters, digits and hyphens. */
export function normalizeYandexDeliveryNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Yandex Delivery numbers are 6 to 40 Latin letters, digits and hyphens');
  return number;
}

/** A scan's "28.04.2026 15:36", checked as a calendar minute and kept as a wall clock. */
function wallClock(raw: string): string | null {
  const match = CLOCK.exec(raw);
  if (!match) return null;
  const parsed = DateTime.fromObject({ year: +match[3]!, month: +match[2]!, day: +match[1]!, hour: +match[4]!, minute: +match[5]! }, { zone: 'UTC' });
  if (!parsed.isValid) return null;
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm");
}

/**
 * Read the tracking page for one number: its history, or a not-found notice naming that
 * number. The page answers both with the whole site around them.
 */
export function parseYandexDeliveryPage(html: string, rawNumber: string): CarrierResult {
  const number = normalizeYandexDeliveryNumber(rawNumber);
  if (typeof html !== 'string' || !html.trim()) throw new SchemaError(PROVIDER, 'Yandex Delivery returned an empty page');
  if (html.length > YANDEX_DELIVERY_MAX_BYTES) throw new SchemaError(PROVIDER, 'Yandex Delivery returned an oversized page');
  const $ = load(html);
  const form = $('form.track-form input[name="order_tracking_id"]');
  if (!form.length) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yandex Delivery answered with a verification page');
    throw new SchemaError(PROVIDER, 'Yandex Delivery answered with a page that is not its tracker');
  }

  const notices = $('.notfound-card');
  const titles = $('#order-title');
  if (notices.length) {
    // "Заказ LO-000000000 не найден — …": the notice names the number it did not find.
    const notice = clean(notices.first().clone().children().remove().end().text(), 200);
    const named = /^Заказ (\S+) не найден(?:\s|$)/.exec(notice);
    if (notices.length !== 1 || titles.length || !named || named[1]!.toUpperCase() !== number) {
      throw new SchemaError(PROVIDER, 'Yandex Delivery returned a not-found notice for another number');
    }
    throw new NotFoundError(PROVIDER);
  }

  if (titles.length !== 1) throw new SchemaError(PROVIDER, 'Yandex Delivery returned a page without the order asked about');
  // The page echoes the number as it was asked, in "Заказ LO-835645864".
  const title = titles.first().text();
  const asked = /^\s*Заказ\s+(\S{1,40})\s*$/.exec(title);
  if (!asked || asked[1]!.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Yandex Delivery answered for another order');

  const tracks = $('ul.order-track');
  if (tracks.length !== 1) throw new SchemaError(PROVIDER, 'Yandex Delivery returned an order without its history');
  const rows = tracks.children('li.track-item');
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Yandex Delivery returned an unreadable history');

  const events: CarrierEvent[] = [];
  rows.each((_index, row) => {
    const content = $(row).children('.track-content');
    const clocks = content.children('.track-time');
    const wordings = content.children('.track-desc');
    const lines = content.children('.track-subtitle');
    if (content.length !== 1 || clocks.length !== 1 || wordings.length !== 1 || lines.length > 1) {
      throw new SchemaError(PROVIDER, 'Yandex Delivery returned an unreadable scan');
    }
    const description = clean(wordings.text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Yandex Delivery returned a scan without wording');
    const clock = clean(clocks.text(), 40);
    const local = clock ? wallClock(clock) : null;
    if (clock && !local) throw new SchemaError(PROVIDER, 'Yandex Delivery returned an invalid scan clock');
    const line = clean(lines.text(), 200);
    const location = line && !DETAIL_WORDING.test(description) && !DETAIL_LINE.test(line) ? line : '';
    const stage = yandexDeliveryStage(description);
    // A scan the page shows without a clock keeps none, in its place among the others.
    events.push({ ...(local ? { local_time: local } : {}), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  });
  // The page lists the oldest scan first. Reverse the rows, keeping same-minute order.
  events.reverse();
  const newest = events[0]!;
  const dated = events.find(event => event.local_time);
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    ...(dated ? { last_update_local: dated.local_time! } : {}),
    expected_delivery: null,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
