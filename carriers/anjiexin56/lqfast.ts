import { accepted, recognizeFromLookup, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
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
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';

// Lanqiao's TMS (蓝桥, lqfast.com), on which Chinese road freight firms run their waybills. Its
// WeChat waybill portal at wx.lqfast.com serves every firm on it, each under an encrypted company
// id its own query page carries; the guest lookup and its reply are the same for all of them.

/** The waybill detail the portal's waybill page asks for. */
export const LQFAST_DETAIL = 'https://wx.lqfast.com/Pub/GET_TYD_DETAIL';
/** The clock of the platform and of the firms on it, which work in China. */
export const LQFAST_ZONE = 'Asia/Shanghai';
// A reply is some twenty kilobytes, most of it the tenant's page template.
const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 300;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Letters and digits with a digit: a waybill number (运单号) or a cargo number (货号).
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/;
// The portal's answer for a number the tenant holds no waybill under.
const NOT_FOUND = /^未找到运单[!！]?$/;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A bracketed contact a row ends with: 【查询电话：0755-…/1…】.
const PHONE_BLOCK = /[【（(][^【】（）()]{0,12}(?:电话|手机|热线|联系方式)[^【】（）()]{0,80}[】）)]/gu;
// The labels of a person, a truck or a phone a row names after them.
const LABEL = '(?:签收人|收货人|提货人|收件人|经办人|联系人|司机|驾驶员|师傅|车牌号?|(?:联系|查询|咨询)?电话|手机(?:号码?)?)';
// A label with its value in brackets or after a colon: 签收人【…】, 车牌号【…】, 司机：….
const LABELLED = new RegExp(`[，,；;。\\s]*${LABEL}\\s*(?:【[^】]{0,40}】|[:：]\\s*[^\\s，,；;。【】]{1,20})`, 'gu');
// A signer the row names between 由 and 签收, as in 已经由…签收 and 货物已由…提货签收.
const SIGNED_BY = /由(?:【[^】]{1,40}】|[^\s，,；;。【】]{1,20}?)(提货)?签收/gu;
// A signer or contact named some other way, or anything that reads as a phone number: the wording stops before it.
const CONTACT = /签收人|联系人|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u;
// The place a row starts with, as the platform's templates put it: 【深圳】开单入库.
const LEADING_PLACE = /^【([^】]{1,40})】/u;

export interface LqfastTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The tenant's encrypted company id, as its query page carries it, unescaped. */
  readonly companyId: string;
  /** The firm's name as the waybill record's carrier (`cygsname`) gives it, when the tenant checks it. */
  readonly company?: RegExp;
  /** A row's stage from its wording, or null to leave it open. */
  readonly stage: (wording: string) => ClassifiedWording | null;
  /** The tenant's status map, which passes over the rows it lists without a stage. */
  readonly statusMap: CarrierStatusMap;
}

/** A number the tenant may hold, without spaces or hyphens. Anything else is not one its lookup finds. */
export function normalizeLqfastNumber(raw: string, provider: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} numbers are five to thirty letters and digits`);
  return number;
}

/** The detail lookup for one number, with the fields the waybill page sends empty. */
export function lqfastLookupUrl(companyId: string, number: string): string {
  return `${LQFAST_DETAIL}?${new URLSearchParams({ companyid: companyId, unit: number, offsetx: '', voffset: '', phone: '', contentzf: '' })}`;
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function lqfastJson(body: string, provider: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/** A field the portal gives as a JSON string: the waybill rows in `Data`, its record in `Data2`. */
function embedded(value: unknown, provider: string): unknown[] {
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid reply`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new SchemaError(provider, `${provider} returned an invalid reply`, { cause });
  }
  if (!Array.isArray(parsed)) throw new SchemaError(provider, `${provider} returned an invalid reply`);
  return parsed;
}

/** A number field of the waybill record, normalized; a field that holds no text or integer is a changed reply. */
function numberField(record: Record<string, unknown>, key: string, provider: string): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return normalizeTrackingNumber(clean(value, 80));
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(value: unknown, provider: string): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]!.length === 5 ? `${match[2]}:00` : match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  return local;
}

/**
 * A row's wording and the place it starts with, without the contacts the portal adds to rows: a
 * branch's enquiry phones, whoever signed, a driver, a truck's plate. The wording stops before any
 * other phone number.
 */
export function lqfastWording(content: string): { description: string; location?: string } {
  const stripped = content.replace(PHONE_BLOCK, '').replace(LABELLED, '').replace(SIGNED_BY, '$1签收');
  const contact = CONTACT.exec(stripped);
  const kept = clean((contact ? stripped.slice(0, contact.index) : stripped), 500).replace(/[\s，,；;。:：/]+$/u, '');
  const place = LEADING_PLACE.exec(kept);
  const location = place ? clean(place[1], 80) : '';
  const description = (place ? kept.slice(place[0].length) : kept).replace(/^[\s，,；;。:：/]+/u, '');
  return { description, ...(location ? { location } : {}) };
}

/**
 * The waybill's rows, newest first as the portal lists them. Each keeps its wall clock in
 * `local_time`, dated on China's clock with `carrier` as the basis; a clock that would date a row
 * after the read keeps its wall clock alone. Rows at one clock keep the reply's order, and a
 * repeated row is read once.
 */
function lqfastScans(rows: readonly unknown[], tenant: LqfastTenant, readAt: number): CarrierEvent[] {
  const { provider } = tenant;
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || (row.content !== null && row.content !== undefined && typeof row.content !== 'string')) {
      throw new SchemaError(provider, `${provider} returned an invalid row`);
    }
    const local = wallClock(row.billdate, provider);
    const { description, location } = lqfastWording(typeof row.content === 'string' ? row.content.slice(0, 2000) : '');
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, LQFAST_ZONE);
    const staged = tenant.stage(description);
    scans.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: LQFAST_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((scan) => scan.event);
}

/**
 * A waybill's history from the portal's `GET_TYD_DETAIL` reply, `{Sus, Data, Msg, Data2, …}`.
 * `Sus` false with `Msg` 未找到运单！ is the answer for a number the tenant holds no waybill under;
 * any other refusal is inconclusive. `Data2` is the waybill's record, whose waybill number (`unit`)
 * or cargo number (`billno`) must be the number asked, and its carrier (`cygsname`) the tenant's firm
 * when the tenant names it; `Data` its rows. Neither the record's
 * shipper, consignee and branch contacts nor the template the page is drawn with are read.
 */
export function parseLqfast(payload: unknown, raw: string, tenant: LqfastTenant, readAt = Date.now()): CarrierResult {
  const { provider } = tenant;
  const number = normalizeLqfastNumber(raw, provider);
  if (!isRecord(payload) || typeof payload.Sus !== 'boolean') throw new SchemaError(provider, `${provider} returned an invalid reply`);
  if (!payload.Sus) {
    const message = typeof payload.Msg === 'string' ? clean(payload.Msg, 120) : '';
    if (NOT_FOUND.test(message)) throw new NotFoundError(provider, `${provider} has no waybill under this number`);
    // Another message refuses the lookup itself, as 解码失败 does a company id the portal cannot read.
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  const records = embedded(payload.Data2, provider);
  if (records.length !== 1 || !isRecord(records[0])) throw new SchemaError(provider, `${provider} returned an invalid waybill`);
  const record = records[0];
  if (![numberField(record, 'unit', provider), numberField(record, 'billno', provider)].includes(number)) {
    throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  }
  // A tenant that names itself checks that the record is its own waybill, not another firm's on the platform.
  const firm = typeof record.cygsname === 'string' ? clean(record.cygsname, 120) : '';
  if (tenant.company && firm && !tenant.company.test(firm)) throw new SchemaError(provider, `${provider} answered for another firm`);
  const events = lqfastScans(embedded(payload.Data, provider), tenant, readAt);
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

/** One lookup on the portal for a tenant, sent once more after a network failure. */
export class LqfastTracker {
  constructor(private readonly tenant: LqfastTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.tenant;
    // The number and the company id alone, with no cookie, session or phone.
    const { response, bytes } = await fetchBounded(lqfastLookupUrl(this.tenant.companyId, number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider, fetcher: this.options.fetcher, maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    if (response.status === 429) throw new RateLimitedError(provider, retryAfterMs(response.headers.get('retry-after')));
    // An unknown number is HTTP 200 too; a redirect or a missing page is a moved route.
    if (response.status !== 200) throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: response.status });
    return parseLqfast(lqfastJson(decodeText(bytes), provider), number, this.tenant, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeLqfastNumber(raw, this.tenant.provider);
    // A request that fails to reach the portal, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** Whether the tenant holds the number: a waybill without a row is held. */
  recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(() => this.fetch(raw, context), () => accepted(() => normalizeLqfastNumber(raw, this.tenant.provider)));
  }
}
