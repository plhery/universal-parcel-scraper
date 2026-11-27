import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { uniconText } from '../unicon-express-us/parser.js';
import { statusMap, yuemaStage } from './status.js';

export const PROVIDER = 'yuema-express';
// A delivered parcel's reply is about 4 kB.
export const YUEMA_MAX_BYTES = 256 * 1024;
/** The JSONP callback the adapter names, as the tracking page's script does. */
export const YUEMA_CALLBACK = 'ehandle';
/**
 * The clock of every row, the ones in the United States too: on it, the flight's take-off in Los Angeles and its
 * landing in China are a day apart, where reading the take-off on Los Angeles time would make the crossing seven
 * hours, and the Los Angeles office's rows fall in its working morning rather than between one and four at night.
 */
export const YUEMA_ZONE = 'Asia/Shanghai';

// The tracker splits its input on commas, so a number is letters and digits only.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const JSONP = new RegExp(`^\\s*${YUEMA_CALLBACK}\\(([\\s\\S]*)\\)\\s*;?\\s*$`);
// The item of a number the tracker does not know, with an empty list.
const NOT_FOUND = /^快递单号不存在[!！]?$/;
// "2022-12-21 08:00": a row's wall clock, with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const CODE = /^[A-Z]{1,6}$/;
// The couriers that deliver in China, by the start of the name the reply gives them: "顺丰（青岛）".
const COURIERS: readonly (readonly [RegExp, string])[] = [[/^顺丰/, 'sf-express']];
// Places the rows misspell.
const PLACES: Readonly<Record<string, string>> = { 'Los Angele': 'Los Angeles' };
const MAX_ROWS = 300;

/** A Yuema Express waybill, as its tracker takes it: letters and digits. */
export function normalizeYuemaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Yuema Express waybill number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The reply inside the `ehandle(…)` wrapper the lookup sends back, or as bare JSON. */
export function yuemaPayload(body: string): unknown {
  try {
    return JSON.parse(JSONP.exec(body)?.[1] ?? body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yuema Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Yuema Express returned a reply that is not JSON', { cause });
  }
}

function textOf(item: Record<string, unknown>, key: string, maxLength = 400): string {
  const value = item[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return invalid(`Yuema Express returned an invalid ${key}`);
  return clean(String(value), maxLength);
}

/** A row's wall clock and its instant on China's clock, which the tracker keeps for every row. */
function clockOf(value: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const parts = CLOCK.exec(value);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001) return invalid('Yuema Express returned a row with an invalid time');
  const local = `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
  const time = firstOccurrence(DateTime.fromISO(local, { zone: YUEMA_ZONE })).toISO({ suppressMilliseconds: true })!;
  return { local_time: local, time, time_zone: YUEMA_ZONE, time_zone_basis: 'carrier' };
}

/** The courier in China and its number, when the catalog knows the courier and its own rules take the number. */
function handoffOf(item: Record<string, unknown>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const company = textOf(item, 'delivery_co', 60);
  const number = normalizeTrackingNumber(textOf(item, 'delivery_no', 64));
  const courier = COURIERS.find(([name]) => name.test(company))?.[1];
  if (!courier || !/^[A-Z0-9]{6,40}$/.test(number)) return {};
  const detection = detectCarrierMatch(number);
  const taken = detection.carrier === courier || (detection.candidates as readonly string[]).includes(courier);
  return taken ? { delivery_carrier: courier, delivery_tracking_number: number } : {};
}

/**
 * Reads the lookup's reply for one waybill: `{data: [{bill, topic, delivery_co, delivery_no, status, list}],
 * status: 1}`. The item must echo the whole number asked. Its list holds Yuema's own rows, from the US store to
 * Chinese customs, each with a code and the place in `state`, and the rows of the courier that delivers in China,
 * coded ZT and QS with no place. Every row keeps its wall clock in `local_time` and gains its instant on China's
 * clock (`YUEMA_ZONE`). The courier's name and phone number come out of its rows, and a row left with nothing is
 * dropped. The destination district, piece count and order code stay behind. A number the tracker does not know
 * gets an item with status 0, the topic `快递单号不存在!` and an empty list.
 */
export function parseYuema(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) return invalid('Yuema Express returned an invalid reply');
  if (payload.status !== 1 || !Array.isArray(payload.data)) {
    if (payload.status === 0) throw new IndeterminateError(PROVIDER, 'Yuema Express did not complete the lookup');
    return invalid('Yuema Express returned an invalid reply');
  }
  const items = payload.data.filter((item): item is Record<string, unknown> => isRecord(item)
    && normalizeTrackingNumber(textOf(item, 'bill', 64)) === number);
  if (items.length === 0) throw new IndeterminateError(PROVIDER, 'Yuema Express answered for another waybill');
  if (items.length > 1) return invalid('Yuema Express listed the waybill twice');
  const item = items[0]!;
  const list = item.list ?? [];
  if (!Array.isArray(list) || list.length > MAX_ROWS) return invalid('Yuema Express returned an invalid list');
  if (item.status === 0) {
    if (list.length === 0 && NOT_FOUND.test(textOf(item, 'topic', 80))) {
      throw new NotFoundError(PROVIDER, 'Yuema Express has no waybill under this number');
    }
    throw new IndeterminateError(PROVIDER, 'Yuema Express did not answer for the waybill');
  }
  const handoff = handoffOf(item);
  if (list.length === 0) {
    throw new NoHistoryError(PROVIDER, 'Yuema Express lists the waybill without a row', { reason: 'listed',
      deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number });
  }

  const seen = new Set<string>();
  const rows: { index: number; event: CarrierEvent & { local_time: string } }[] = [];
  list.forEach((row, index) => {
    if (!isRecord(row)) return invalid('Yuema Express returned an invalid row');
    const code = textOf(row, 'code', 10);
    const remark = textOf(row, 'remark', 600);
    if (!CODE.test(code) || !remark) return invalid('Yuema Express returned a row without its code or wording');
    const clock = clockOf(textOf(row, 'time', 30));
    const description = uniconText(remark);
    // A row that only named the courier and gave their phone number.
    if (!description) return;
    const state = textOf(row, 'state', 80);
    const location = PLACES[state] ?? state;
    const key = JSON.stringify([clock.local_time, code, location, description]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = yuemaStage(code, description);
    rows.push({ index, event: { ...clock, local_time: clock.local_time!, description, provider_code: code,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } });
  });
  if (rows.length === 0) return invalid('Yuema Express returned a list without a readable row');

  // The list runs oldest first; the result runs newest first, rows of one minute in the reverse of their order.
  const events = rows.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index)
    .map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...handoff,
    events,
  };
}
