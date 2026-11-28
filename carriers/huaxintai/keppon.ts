/**
 * Keppon's online tracking page (科邦在线查询平台), the guest page of the TMS Keppon (科邦, keppon.cn)
 * sells road freight firms. Each firm's page is `OnlineTrack.aspx` on a host and port of its own,
 * reached with a tenant id (`cid`) and up to five comma-separated waybills (`yid`); the server renders
 * each waybill's summary and its rows into the page. This module holds the request and the reader a
 * firm on it shares; the firm keeps its page, tenant id, number shape and wordings.
 */
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, textFromHtml, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

/** The clock of the firms on the platform, which work in China. */
export const KEPPON_ZONE = 'Asia/Shanghai';
// A page is some twelve kilobytes, most of it the page's template.
const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 300;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Letters and digits with a digit: the page's own example gives waybills of nine and eleven digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,20}$/;
// A row's clock, as 2026/5/7 8:44:39, its hour and minute to the second or the minute.
const CLOCK = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// The page's line for numbers it holds no waybill under.
const NOT_FOUND = '没有搜到任何运单信息';
// The summary table, its waybill rows, and a row's cells.
const SUMMARY = /<table\b[^>]*\bclass="table_head"[^>]*>([\s\S]*?)<\/table>/g;
const SUMMARY_ROW = /<tr class="tbtxt2">([\s\S]*?)<\/tr>/g;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
// A waybill's rows: its number in bold, then the table of its rows.
const DETAIL = /<strong\b[^>]*>([^<]*)<\/strong>\s*<table\b[^>]*\bclass="tabr1"[^>]*>([\s\S]*?)<\/table>/g;
const HEADER = /<tr class="tabr1_head">[\s\S]*?<\/tr>/g;
const ROW = /<tr class="tabr1_sj">\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The labels of a person, a truck or a phone a row names after them.
const LABEL = '(?:签收人|收货人|提货人|收件人|经办人|联系人|司机|驾驶员|师傅|车牌号?|(?:联系|查询|咨询)?电话|手机(?:号码?)?)';
// A label with its value in brackets or after a colon: 签收人【…】, 司机：….
const LABELLED = new RegExp(`[，,；;。\\s]*${LABEL}\\s*(?:【[^】]{0,40}】|[:：]\\s*[^\\s，,；;。【】]{1,20})`, 'gu');
// A signer or contact named some other way, or anything that reads as a phone number: the wording stops before it.
const CONTACT = /签收人|收货人|联系人|司机|(?:联系|查询|咨询)?(?:电话|手机)(?:号码?)?\s*\d|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u;
// The place a row starts with, as 【长沙市】,…; the platform leaves it empty, 【】, when it has none.
const LEADING_PLACE = /^【([^【】]{0,40})】[\s，,]*/u;
// A depot a row names elsewhere, as 进入【沈阳营业部】仓库.
const PLACE = /【([^【】]{1,40})】/u;

export interface KepponTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The firm's `OnlineTrack.aspx`, on its own host and port. */
  readonly page: string;
  /** The tenant id the firm's links give the page. */
  readonly cid: string;
  /** A row's stage from its wording, or null to leave it open. */
  readonly stage: (wording: string) => ClassifiedWording | null;
  /** The tenant's status map, which passes over the rows it lists without a stage. */
  readonly statusMap: CarrierStatusMap;
}

/** A number the firm may hold, without spaces or hyphens. Anything else is not one its page finds. */
export function normalizeKepponNumber(raw: string, provider: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} numbers are four to twenty letters and digits`);
  return number;
}

/** The firm's page for one number. */
export function kepponLookupUrl(tenant: Pick<KepponTenant, 'page' | 'cid'>, number: string): string {
  return `${tenant.page}?${new URLSearchParams({ cid: tenant.cid, yid: number })}`;
}

/**
 * A row's wording and its place, without whoever signed, a driver, a truck's plate or a phone. The
 * place is the one the row starts with in brackets, else the first depot it names in brackets.
 */
export function kepponWording(content: string): { description: string; location?: string } {
  const stripped = clean(content, 2000).replace(LABELLED, '');
  const contact = CONTACT.exec(stripped);
  const kept = clean(contact ? stripped.slice(0, contact.index) : stripped, 500).replace(/[\s，,；;。:：/]+$/u, '');
  const leading = LEADING_PLACE.exec(kept);
  const description = (leading ? kept.slice(leading[0].length) : kept).replace(/^[\s，,；;。:：/]+/u, '');
  const location = clean(leading ? leading[1] : PLACE.exec(kept)?.[1], 80);
  return { description, ...(location ? { location } : {}) };
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(value: string, provider: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const two = (part: string | undefined) => (part ?? '00').padStart(2, '0');
  const local = match ? `${match[1]}-${two(match[2])}-${two(match[3])}T${two(match[4])}:${match[5]}:${two(match[6])}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  return local;
}

/** The text of each cell of a table row. */
const cells = (row: string): string[] => [...row.matchAll(CELL)].map((cell) => textFromHtml(cell[1], 200));

/**
 * The waybill's rows, newest first. Each keeps its wall clock in `local_time`, dated on China's
 * clock with `carrier` as the basis; a clock that would date a row after the read keeps its wall
 * clock alone. Rows at one clock keep the page's order, and a repeated row is read once.
 */
function kepponScans(table: string, tenant: KepponTenant, readAt: number): CarrierEvent[] {
  const { provider } = tenant;
  const body = table.replace(HEADER, '');
  const rows = [...body.matchAll(ROW)];
  // Rows the pattern did not read are a changed page.
  if (body.replace(ROW, '').replace(/<\/?tbody>/g, '').trim()) throw new SchemaError(provider, `${provider} returned an invalid row`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, [, clock, content]] of rows.entries()) {
    const local = wallClock(textFromHtml(clock, 40), provider);
    const { description, location } = kepponWording(textFromHtml(content, 2000));
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, KEPPON_ZONE);
    const staged = tenant.stage(description);
    scans.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: KEPPON_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index))
    .map((scan) => scan.event);
}

/**
 * A waybill's history from the firm's page. The summary table holds a row per waybill found, whose
 * first cell is its number, or the line 没有搜到任何运单信息 when the firm holds none under the
 * number asked. Each waybill found then has its number in bold over the table of its rows, oldest
 * first. Both must be the number asked. The summary's branches and state, and the progress bar
 * under the rows, are not read.
 */
export function parseKeppon(html: string, raw: string, tenant: KepponTenant, readAt = Date.now()): CarrierResult {
  const { provider } = tenant;
  const number = normalizeKepponNumber(raw, provider);
  const summaries = [...html.matchAll(SUMMARY)];
  if (summaries.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`);
    throw new SchemaError(provider, `${provider} returned an invalid page`);
  }
  const summary = summaries[0]![1]!;
  const listed = [...summary.matchAll(SUMMARY_ROW)].map((row) => cells(row[1]!));
  if (!listed.length) {
    if (textFromHtml(summary, 2000).includes(NOT_FOUND)) throw new NotFoundError(provider, `${provider} has no waybill under this number`);
    throw new SchemaError(provider, `${provider} returned an invalid summary`);
  }
  if (listed.length !== 1 || normalizeTrackingNumber(listed[0]![0] ?? '') !== number) {
    throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  }
  const details = [...html.matchAll(DETAIL)];
  if (details.length > 1 || (details.length && normalizeTrackingNumber(textFromHtml(details[0]![1], 64)) !== number)) {
    throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  }
  const events = details.length ? kepponScans(details[0]![2]!, tenant, readAt) : [];
  if (!events.length) throw new NoHistoryError(provider, `${provider} lists the waybill without a row`, { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, tenant.statusMap);
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

/** One lookup on a firm's page, sent once more after a network failure. */
export class KepponTracker {
  constructor(private readonly tenant: KepponTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.tenant;
    // The tenant id and the number alone, with no cookie, session or phone.
    const { response, bytes } = await fetchBounded(kepponLookupUrl(this.tenant, number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider, fetcher: this.options.fetcher, maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    if (response.status === 429) throw new RateLimitedError(provider, retryAfterMs(response.headers.get('retry-after')));
    // An unknown number is HTTP 200 too; a redirect or a missing page is a moved route.
    if (response.status !== 200) throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: response.status });
    return parseKeppon(decodeText(bytes), number, this.tenant, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKepponNumber(raw, this.tenant.provider);
    // A request that fails to reach the page, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
