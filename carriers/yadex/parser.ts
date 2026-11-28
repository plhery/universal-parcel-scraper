import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { statusMap, yadexStage } from './status.js';

export const PROVIDER = 'Yadex';
export const CARRIER = 'yadex';
export const YADEX_MAX_BYTES = 256_000;
// The public example is twelve digits; the tracker's form takes the waybill number alone.
const NUMBER = /^\d{10,14}$/;
// One row of the timeline the tracker returns for the page to append.
const ROW = /<div class="layui-timeline-title">([\s\S]*?)<\/div>/g;
// "2023-01-11 15:06:58    到达【环滘】": the scan's wall clock in China, then its wording.
const LINE = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+(\S[\s\S]*)$/;
// "单号990000000017 暂无物流记录": the tracker's answer for a number it holds no record for.
const NOT_FOUND = /^单号\s*([A-Za-z0-9]+)\s*暂无物流记录$/u;
// The station's or courier's phone numbers the tracker puts after a row, and the signer's name.
const CONTACTS = /\s*(?:联系电话|电话|手机|短号)[:：]?\s*\[[^\]]*\]/gu;
const PERSON = /[，,]?\s*(?:签收人|派件员|派送员|快递员|业务员|收件员)[:：]?\s*【[^】]*】/gu;
const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// The station a row happened at: where it arrived, the one it left, or where it was signed for.
const STATION = /(?:到达|离开|签收站点)【([^【】]{1,40})】/u;
const MAX_SCANS = 200;

/** A Yadex waybill number, as the tracking form takes it: digits, without spaces. */
export function normalizeYadexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Yadex waybill numbers are ten to fourteen digits');
  return number;
}

/** A row's wording without the phone numbers and names the tracker puts in it. */
function withoutContacts(text: string): string {
  return text.replace(CONTACTS, '').replace(PERSON, '').replace(MOBILE, '').replace(/\s+/g, ' ').trim();
}

/**
 * The timeline the tracker returns for one number, newest first as it lists them: each row a time
 * on China's clock without a zone and a Chinese wording that names the station. A number it holds
 * nothing for is one sentence naming the number.
 */
export function parseYadex(body: string, raw: string): CarrierResult {
  const number = normalizeYadexNumber(raw);
  const plain = textFromHtml(body, 200);
  const missing = NOT_FOUND.exec(plain);
  if (missing) {
    if (normalizeTrackingNumber(missing[1]!) === number) throw new NotFoundError(PROVIDER, `${PROVIDER} has no record under this number`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered about another number`);
  }
  const rows = [...body.matchAll(ROW)];
  if (!rows.length) throw new SchemaError(PROVIDER, `${PROVIDER} returned neither scans nor its not-found answer`);
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, `${PROVIDER} returned too many scans`);
  const seen = new Set<string>();
  const scans = rows.map((row, index) => {
    const line = LINE.exec(textFromHtml(row[1], 400));
    const day = line ? calendarDay(Number(line[1]), Number(line[2]), Number(line[3])) : null;
    if (!line || !day) throw new SchemaError(PROVIDER, `${PROVIDER} returned a scan without a readable time`);
    const local_time = `${day}T${line[4]}:${line[5]}:${line[6]}`;
    const description = withoutContacts(line[7]!).slice(0, 200);
    const location = STATION.exec(description)?.[1]?.trim();
    const staged = yadexStage(description);
    const event: CarrierEvent & { local_time: string } = {
      local_time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return event.description && !seen.has(key) && Boolean(seen.add(key));
  });
  if (!scans.length) throw new SchemaError(PROVIDER, `${PROVIDER} returned scans without a wording`);
  const events = scans.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index)
    .map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}
