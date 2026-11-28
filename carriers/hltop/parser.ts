import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { hltopStage, statusMap } from './status.js';

export const PROVIDER = 'Hailian Express';
export const CARRIER = 'hltop';
// A waybill's page is about twelve kilobytes.
export const HLTOP_MAX_BYTES = 512 * 1024;
// Ten and twelve digits on the public samples; the form takes any waybill.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
// "2023-05-30 08:09:45": Shanghai's wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// A clause that names a person or gives a phone: the courier, a signer, a phone.
const CONTACT = /电话|手机|致电|联系|电联|快递员|快递小哥|派送员|派件员|收派员|配送员|业务员|司机|姓名|签收人|代收人|收件人|收货人|交给|\d{7,}/u;
// The YunSuo (云锁) check in front of www.hltop.com, and other browser checks.
const CHALLENGE = /security_verify_data|security_session_verify|srcurl|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** A waybill on Hailian's tracker, without spaces or hyphens. */
export function normalizeHltopNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hailian waybills are 6 to 30 letters and digits');
  return number;
}

/** A row's text without the courier or a phone: each clause that names one goes. */
export function hltopText(value: string): string {
  const text = clean(value, 1000);
  const kept = text.split(/(?<=[，,；;。])/u).filter((clause) => !CONTACT.test(clause));
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : '';
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/**
 * Hailian's history for one waybill, newest first, from `search.asp`: a 主单信息 table (date taken in, pieces,
 * destination, the delivery address and the status) and a 详细追踪信息 table of rows, each a wall clock on
 * Shanghai's clock and a text. Both tables are headed by the number asked. The page with both tables empty under
 * that number is the tracker's only answer for a waybill it does not know. The delivery address is never read,
 * and the courier a row names is taken out. A clock that would date a row after the lookup leaves it its wall
 * clock alone.
 */
export function parseHltop(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHltopNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  const $ = load(html);
  const summary = $('table#table11');
  const heading = $('table#table5');
  const history = $('table#table6');
  const echoes = [summary, heading].map((table) => normalizeTrackingNumber(clean(table.find('font[color=red]').first().text(), 64)));
  if (summary.length !== 1 || heading.length !== 1 || history.length !== 1 || !echoes.every(Boolean)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its waybill`);
  }
  if (echoes.some((echo) => echo !== number)) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  // The summary's first two rows are its heading and its column names; a known waybill adds one more.
  const known = summary.find('tr').length > 2;
  const rows = history.find('tr').filter((_, row) => $(row).children('td').length >= 2 && !$(row).hasClass('sectionheading'));
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  if (!rows.length) {
    if (!known) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    throw new NoHistoryError(PROVIDER);
  }
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    const local = wallClock(cells.eq(0).text());
    const description = hltopText(cells.eq(1).text());
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = hltopStage(description);
    events.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists the rows newest first.
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
