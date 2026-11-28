import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { ks2homeStage, statusMap } from './status.js';

export const CARRIER = 'ks2home';
export const PROVIDER = 'Ks2Home';
/** The waybill page the site's form opens, which the server renders with the number's rows. */
export const KS2HOME_QUERY = 'http://www.ks2home.de/express/query/';
// The page is some twenty kilobytes, most of it the site's template.
export const KS2HOME_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 200;
// Letters and digits with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The heading over a number's rows: "单号 <span>…</span> 的查询结果".
const RESULT = /<h2>\s*单号\s*<span>([^<]{1,60})<\/span>\s*的查询结果\s*<\/h2>/gu;
// The page's answer for a number it holds no waybill under.
const NOT_FOUND = /<h2>\s*单号不存在\s*<\/h2>/u;
const LIST = /<ul id="express-list-0">([\s\S]*?)<\/ul>/u;
const ROW = /<li>([\s\S]*?)<\/li>/gu;
const CLOCK_CELL = /<div class="s17-eve-time-tim">\s*<span>([^<]*)<\/span>/u;
const TITLE = /<h4>([\s\S]*?)<\/h4>/u;
const DETAIL = /<p>([\s\S]*?)<\/p>/u;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The place a heading starts with: "【德国-法兰克福】仓库处理中".
const LEADING_PLACE = /^【([^【】]{1,40})】\s*/u;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** A waybill number for Ks2Home's tracker, without spaces or hyphens. */
export function normalizeKs2homeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Ks2Home waybill numbers are six to thirty letters and digits');
  return number;
}

/** The waybill page for a number. */
export const ks2homeQueryUrl = (number: string): string => `${KS2HOME_QUERY}?code=${encodeURIComponent(number)}`;

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's wall clock; a time the calendar has not is a changed page. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  return parsed && parsed.iso.slice(0, 19) === local ? local : invalid('Ks2Home returned an invalid scan time');
}

/**
 * The rows under the number's heading, newest first. Each is the heading's wording, without the
 * place in 【】 it starts with, and the line under it; each keeps its wall clock alone, as the page
 * names no zone.
 */
function ks2homeScans(list: string): CarrierEvent[] {
  const rows = [...list.matchAll(ROW)].map((match) => match[1]!);
  if (rows.length > MAX_ROWS) return invalid('Ks2Home returned an oversized history');
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    const clock = CLOCK_CELL.exec(row);
    const title = TITLE.exec(row);
    if (!clock || !title) return invalid('Ks2Home returned an invalid row');
    const local = wallClock(textFromHtml(clock[1], 40));
    const heading = textFromHtml(title[1], 200);
    const place = LEADING_PLACE.exec(heading);
    const wording = clean(place ? heading.slice(place[0].length) : heading, 200);
    const detail = textFromHtml(DETAIL.exec(row)?.[1], 300);
    const description = detail && detail !== wording ? `${wording} - ${detail}` : wording;
    if (!description) continue;
    const location = place ? clean(place[1], 80) : '';
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = ks2homeStage(description);
    scans.push({ local, index, event: {
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index))
    .map((scan) => scan.event);
}

/**
 * A waybill's history from the page the server renders for it: the heading 单号 <number> 的查询结果
 * over its rows, or 单号不存在 for a number it holds no waybill under. The heading must name the
 * number asked. The domestic courier's rows, which the page asks a relay for once it has loaded,
 * are not read.
 */
export function parseKs2home(html: string, raw: string): CarrierResult {
  const number = normalizeKs2homeNumber(raw);
  const page = html.slice(0, KS2HOME_MAX_BYTES);
  const headings = [...page.matchAll(RESULT)];
  if (!headings.length) {
    if (NOT_FOUND.test(page)) throw new NotFoundError(PROVIDER, 'Ks2Home has no waybill under this number');
    if (CHALLENGE.test(page)) throw new ChallengeError(PROVIDER, 'Ks2Home answered with a browser check');
    return invalid('Ks2Home returned a page without its answer');
  }
  if (headings.length !== 1 || normalizeTrackingNumber(textFromHtml(headings[0]![1], 60)) !== number) {
    return invalid('Ks2Home did not answer for the waybill asked');
  }
  const list = LIST.exec(page.slice(headings[0]!.index));
  if (!list) return invalid('Ks2Home returned a waybill without its list');
  const events = ks2homeScans(list[1]!);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Ks2Home lists the waybill without a row', { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
