import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { dpdRuRequestNumber } from './number.js';
import { dpdRuMappedStage, dpdRuStage } from './status.js';

export const PROVIDER = 'DPD Russia';
// An answer is about ten kilobytes.
export const DPD_RU_MAX_BYTES = 512 * 1024;
const DAY = /^\d{2}\.\d{2}\.\d{4}$/;
const DAY_AND_CLOCK = /^(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2})$/;
// A firewall's or CDN's page in place of the tracker's answer, which can come back with HTTP 200.
const BLOCKED = /servicepipe|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const NOT_FOUND = /^Информация по вашему запросу не найдена\. Пожалуйста, попробуйте еще раз\.$/;
const TOWN = /^(.+?)\s*\(([^()]+)\)\.?$/;
const RETURN_UNDER = /Возврат осуществляется по номеру ((?:RU|BY|KZ)\d{9}|\d{11})\b/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A calendar day as the tracker writes it, `DD.MM.YYYY`, in ISO form. */
function calendarDay(text: string): string | null {
  if (!DAY.test(text)) return null;
  // UTC checks the calendar fields only: the tracker gives a day, not a clock.
  const day = DateTime.fromFormat(text, 'dd.MM.yyyy', { zone: 'UTC' });
  return day.isValid && day.toFormat('dd.MM.yyyy') === text ? day.toFormat('yyyy-MM-dd') : null;
}

/** The shipment table's values by their label. */
function shipmentTable($: CheerioAPI): Map<string, string> {
  const values = new Map<string, string>();
  for (const row of $('#tracing_table tr').toArray()) {
    const cells = $(row).children('td');
    if (cells.length === 2) values.set(clean(cells.eq(0).text(), 80), clean(cells.eq(1).text(), 200));
  }
  return values;
}

/** The history, newest first: each row's day, wording and town, the town moved out of the wording. */
function history($: CheerioAPI): CarrierEvent[] {
  const rows = $('#trackHistory tr').not('.table_colour_six').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DPD Russia returned an oversized history');
  const events = rows.map((row): CarrierEvent => {
    const cells = $(row).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'DPD Russia returned an invalid history row');
    const day = calendarDay(clean(cells.eq(0).text(), 20));
    if (!day) throw new SchemaError(PROVIDER, 'DPD Russia returned an invalid event date');
    const wording = clean(cells.eq(1).text(), 300);
    if (!wording) throw new SchemaError(PROVIDER, 'DPD Russia returned an event without wording');
    const town = TOWN.exec(wording);
    const description = town ? town[1]! : wording;
    const staged = dpdRuStage(description);
    return { local_time: day, description, ...(town ? { location: town[2]!.trim(), original_description: wording } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  // The tracker lists the oldest first; rows of the same day keep their order.
  return events.reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));
}

/** The clock of the delivery, `DD.MM.YYYY HH:MM`, from the table of delivered parcels the tracker adds. */
function deliveryClock($: CheerioAPI): string | null {
  const table = $('table.module_table').filter((_, node) => $(node).find('td').toArray()
    .some((cell) => clean($(cell).text(), 40) === 'Дата/время получения'));
  if (table.length !== 1) return null;
  const clocks = new Set<string>();
  for (const row of table.find('tr').toArray().slice(1)) {
    const cells = $(row).children('td');
    if (cells.length < 3 || clean(cells.eq(1).text(), 40) !== 'Доставлено') continue;
    const written = DAY_AND_CLOCK.exec(clean(cells.eq(2).text(), 40));
    const day = written ? calendarDay(written[1]!) : null;
    const clock = written ? DateTime.fromFormat(written[2]!, 'HH:mm', { zone: 'UTC' }) : null;
    if (day && clock?.isValid && clock.toFormat('HH:mm') === written![2]) clocks.add(`${day}T${written![2]}:00`);
  }
  // Pieces delivered at different clocks give no one clock for the parcel.
  return clocks.size === 1 ? [...clocks][0]! : null;
}

function weight(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,6}(?:\.\d{1,3})?$/.test(text)) return undefined;
  const kilograms = Number(text);
  return kilograms > 0 ? kilograms : undefined;
}

/**
 * The fragment `POST /ols/trace2/standard.do2?method:search` answers with: a
 * one-line notice that the tracker holds nothing under the number, or the
 * order's current status, history, oldest first with a day and no clock, and
 * shipment table. The answer is read only when its hidden field and its
 * shipment table show the whole number asked.
 */
export function parseDpdRu(html: string, raw: string): CarrierResult {
  const number = dpdRuRequestNumber(raw);
  const $ = load(html);
  const field = $('input#hiddenOrderNum');
  if (field.length !== 1) {
    if (NOT_FOUND.test(clean($.root().text(), 300)) && html.length < 4096) throw new NotFoundError(PROVIDER);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DPD Russia answered with a browser check');
    throw new SchemaError(PROVIDER, 'DPD Russia did not return its tracking answer');
  }
  if (clean(field.attr('value') ?? '', 64) !== number) throw new SchemaError(PROVIDER, 'DPD Russia did not look the number up');
  const shipment = shipmentTable($);
  if (shipment.get('Номер отправки') !== number) throw new IndeterminateError(PROVIDER, 'DPD Russia answered for another order');

  const events = history($);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  // An order handed on to a return names the return's number in its current status.
  if (RETURN_UNDER.test(clean($('td.current-status').text(), 1000)) && dpdRuMappedStage(newest.description!) === 'exception') {
    Object.assign(newest, { stage: 'returned', stage_source: 'carrier_map' });
  }
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  if (stage === 'delivered' && current === newest) {
    const clock = deliveryClock($);
    if (clock?.startsWith(newest.local_time!)) newest.local_time = clock;
  }
  const due = calendarDay(shipment.get('Дата доставки') ?? '');
  const expected = due && stage && !['delivered', 'returned', 'exception'].includes(stage) && due >= newest.local_time!.slice(0, 10) ? due : null;
  const service = shipment.get('Услуга');
  const destination = shipment.get('Пункт назначения');
  const kilograms = weight(shipment.get('Физический вес (кг)'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: expected,
    ...(service ? { service_name: service } : {}),
    ...(destination ? { receiver_address: destination } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
