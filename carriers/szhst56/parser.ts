import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { statusMap, szhst56Stage } from './status.js';

export const PROVIDER = 'Hongshuntong Logistics';
export const CARRIER = 'szhst56';
// A page is some ten kilobytes, most of it the site's template.
export const SZHST56_MAX_BYTES = 256 * 1024;
/** Every row is written in China by the firm's branches, on China's clock. */
export const SZHST56_ZONE = 'Asia/Shanghai';

// Letters and digits with a digit: seven digits on the sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The block under the form: a heading per number asked, then its rows newest first.
const BLOCK = /<div class="look_things">([\s\S]*?)<\/div>/g;
const HEADING = /<h2\b[^>]*>([\s\S]*?)<\/h2>/g;
const FOUND = /^单号(.{1,64}?)跟踪扫描记录$/u;
// The page's answer for a number it holds no record under.
const NOT_FOUND = /^单号(.{1,64}?)无效或暂无追踪记录[.。]?$/u;
const LIST = /<ul class="look_list">([\s\S]*?)<\/ul>/g;
const ROW = /<li>\s*<span>([^<]*)<\/span>([\s\S]*?)<\/li>/g;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A person or a phone a row gives after a label and a colon: 收货人：….
const LABELLED = /[，,；;\s]*(?:收货人|收件人|签收人|提货人|联系人|司机|驾驶员|车牌号?|(?:联系)?电话|手机(?:号码?)?)\s*[:：]\s*[^，,；;。\s]{1,20}/gu;
// A phone written some other way: the wording stops before it.
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u;
// The depot a row arrives at, or the branch that opened the waybill. The firm writes 己 for 已.
const ARRIVED = /[已己]?到达?([^，,。；;\s：:]{1,20}?(?:分拨中心|中转中心|中转场|网点|营业部|仓库?))/u;
const OPENED = /由([^，,。；;\s：:]{1,20}?(?:网点|营业部|分拨中心))开单/u;
const MAX_ROWS = 300;

/** A Hongshuntong waybill, without spaces or hyphens. */
export function normalizeSzhst56Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hongshuntong Logistics waybills are 5 to 30 letters and digits');
  return number;
}

/** A row's wording without the consignee, signer, driver or phone it names, and the depot it names, if any. */
export function szhst56Row(value: string): { description: string; location?: string } {
  const text = textFromHtml(value, 2000).replace(LABELLED, '');
  const phone = PHONE.exec(text);
  const description = clean(phone ? text.slice(0, phone.index) : text, 300)
    .replace(/\s+(?=[，,；;。])/gu, '').replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
  const location = clean((ARRIVED.exec(description) ?? OPENED.exec(description))?.[1], 80);
  return { description, ...(location ? { location } : {}) };
}

/** A row's wall clock to the second; a time the calendar has not is a changed page. */
function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  return local;
}

/**
 * The waybill's rows, newest first as the page lists them. Each keeps its wall clock in
 * `local_time`, dated on China's clock with `carrier` as the basis; a clock that would date a row
 * after the read keeps its wall clock alone. A repeated row is read once.
 */
function scans(list: string, readAt: number): CarrierEvent[] {
  const rows = [...list.matchAll(ROW)];
  // Rows the pattern did not read are a changed page.
  if (list.replace(ROW, '').trim()) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const seen = new Set<string>();
  const events: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, [, clock, content]] of rows.entries()) {
    const local = wallClock(textFromHtml(clock, 40));
    const { description, location } = szhst56Row(content!);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, SZHST56_ZONE);
    const staged = szhst56Stage(description);
    events.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: SZHST56_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return events.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((scan) => scan.event);
}

/**
 * A waybill's history from the tracking page. Under the form, the page heads each number asked
 * with 单号…跟踪扫描记录 over its rows, or with 单号…无效或暂无追踪记录. for a number it holds no
 * record under. The heading must name the number asked.
 */
export function parseSzhst56(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeSzhst56Number(raw);
  const blocks = [...html.matchAll(BLOCK)];
  if (blocks.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid page`);
  }
  const block = blocks[0]![1]!;
  const headings = [...block.matchAll(HEADING)].map((heading) => textFromHtml(heading[1], 200));
  if (headings.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid page`);
  const missing = NOT_FOUND.exec(headings[0]!);
  const found = FOUND.exec(headings[0]!);
  const named = normalizeTrackingNumber(clean((missing ?? found)?.[1], 64));
  if (!missing && !found) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid page`);
  if (named !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  if (missing) throw new NotFoundError(PROVIDER, `${PROVIDER} has no record under this number`);
  const lists = [...block.matchAll(LIST)];
  if (lists.length > 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid page`);
  const events = lists.length ? scans(lists[0]![1]!, readAt) : [];
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the waybill without a row`, { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
