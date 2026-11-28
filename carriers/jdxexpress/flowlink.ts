/**
 * Changyunda's FlowLink forwarding system. Each forwarder on it has its own API host,
 * `flowlink<tenant>.changyunda.cn`, whose open `TrackingSelectDomain` route answers a waybill's rows; a tenant
 * brings its subdomain, the clock its rows are written on and its status map (`flowlinkStatusMap()` in
 * `flowlinkStatus.ts`), and `flowlinkAdapter()` does the rest.
 */
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

export { flowlinkStatusMap, flowlinkTemplate, type FlowLinkEntry } from './flowlinkStatus.js';

// A waybill's rows come to a few kilobytes.
const FLOWLINK_MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
// The route takes the forwarder's waybill or the number it was handed on under: letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const TENANT = /^[a-z0-9]{2,40}$/;
// "2026-05-30 01:46:17": the wall clock the system writes, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,7})?$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_WAYBILLS = 20;
const MAX_ROWS = 300;
// The system's answer for a number it holds no waybill under.
const NOT_FOUND = 'NotExistsCNum';
// Couriers in China a waybill may be handed to, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'],
];

// A phone: a mobile, masked or not, a landline with its area code, a courier's hotline, a bare local number.
const PHONE = /(?<![\dA-Z*-])(?:(?:\+?86[- ]?)?1[3-9]\d(?:\d{4}|\*{4})\d{4}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4}|\d{7,8})(?![\dA-Z*-])/iu;
// A waybill or box number after its label, which is no phone.
const LABELLED_NUMBER = /(?:转?单号|运单号|箱号)\s*[:：]?\s*[A-Z\d]+/giu;
// Words that ask the reader to call, or give a hotline.
const INVITE = /电话|手机|致电|联系|电联|热线|投诉|客服|拨打|呼叫|号码/u;
// The people a relayed row may name: couriers, drivers, signers.
const ROLE = '快递员|快递小哥|小哥|派件员|派送员|派件人|派送人|收件员|收派员|揽收员|揽件员|揽投员|投递员|配送员|业务员|司机|签收人|收件人|收货人|代收人';
// A courier named with a phone: "…公司(…)的张三(138…) 已揽收".
const NAMED = new RegExp(String.raw`(?:的|由)\s*[^，,。；;（()【】[\]\s]{1,30}\s*[（(]\s*(?:${PHONE.source})\s*[)）]`, 'giu');
// A person after their role and a colon, "派送人：张三", or in brackets after it, "派件员【张三】", which keeps the role.
const ROLE_COLON = new RegExp(String.raw`(?:${ROLE})\s*[:：]\s*[^，,。；;\s【】()（）[\]]{1,20}`, 'gu');
const ROLE_BRACKET = new RegExp(String.raw`(${ROLE})\s*(?:【[^【】]{0,40}】|\[[^[\]]{0,40}\]|（[^（）]{0,40}）|\([^()]{0,40}\))`, 'gu');
// A bracketed or parenthesized part without another of its kind inside.
const GROUP = /【[^【】]*】|\[[^[\]]*\]|（[^（）]*）|\([^()]*\)/gu;
// What a row goes on to after its news: a courtesy, an invitation to follow an account, the time of the next update.
const AFTERWORD = /^(?:如有|如遇|如需|若有|若出现|若|可关注|关注|感谢|每一次|每份|请放心|请您放心|预计将|物流问题)/u;
// A place at the start of a row: "[新界]", "【佛山市】".
const PLACE = /^(?:\[([^[\]]{1,20})\]|【([^【】]{1,20})】)/u;

/** A FlowLink tenant. */
export interface FlowLinkSite {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The tenant's API subdomain without its `flowlink` prefix. */
  readonly tenant: string;
  /** The tenant's tracking page, sent as Referer. */
  readonly page?: string;
  /** The zone every row's wall clock is read on, and how it was chosen. */
  readonly zone: string;
  readonly zoneBasis: 'carrier' | 'destination' | 'place';
  readonly statusMap: CarrierStatusMap;
}

/** A waybill on a FlowLink tenant's tracker, without spaces or hyphens. */
export function normalizeFlowLinkNumber(site: FlowLinkSite, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(site.provider, `${site.provider} waybills are 6 to 30 letters and digits`);
  return number;
}

/** The route a tenant's tracking page asks for one waybill. */
export function flowlinkLookupUrl(site: FlowLinkSite, number: string): string {
  if (!TENANT.test(site.tenant)) throw new TypeError(`Invalid FlowLink tenant ${site.tenant}`);
  return `http://flowlink${site.tenant}.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?${new URLSearchParams({ CNum: number })}`;
}

/** The page's headers: the route takes the number in its address and an empty body. */
export function flowlinkHeaders(site: FlowLinkSite, userAgent?: string): Record<string, string> {
  const page = site.page ? new URL(site.page) : null;
  return { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(userAgent),
    ...(page ? { Origin: page.origin, Referer: `${page.origin}/` } : {}) };
}

/** Whether a text gives a phone, apart from the waybills it labels. */
function givesPhone(value: string): boolean {
  return PHONE.test(value.replace(LABELLED_NUMBER, ''));
}

/**
 * A row's text without the people and phones it names: a courier named with a phone, a bracket or parenthesis
 * that holds a phone or a contact, a person after their role, then the row from its first clause that gives a
 * phone, asks the reader to call or follows the news with a courtesy. A waybill after 单号 is no phone and stays.
 */
export function flowlinkText(raw: string): string {
  let text = clean(raw, 2000).replace(NAMED, '');
  // A bracket nested in another goes first, then the one around it if it held a contact too.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(GROUP, (part) => (givesPhone(part) || INVITE.test(part) ? '' : part));
    if (next === text) break;
    text = next;
  }
  text = text.replace(ROLE_COLON, '').replace(ROLE_BRACKET, '$1');
  const kept: string[] = [];
  for (const clause of text.split(/(?<=[，,。；;！!？?])(?![^【】]*】)(?![^[\]]*\])/u)) {
    const words = clause.trim();
    if (givesPhone(words) || INVITE.test(words) || AFTERWORD.test(words)) break;
    kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。、]+$/gu, '');
}

/** A row's stage, by the tenant's map, else by the shared wording rules, or none. */
export function flowlinkStage(site: FlowLinkSite, description: string, code: string): ClassifiedWording | null {
  const stage = site.statusMap.stage(code || null, normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}

function wallClock(site: FlowLinkSite, value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(site.provider, `${site.provider} returned an invalid row time`);
  }
  return local;
}

function text(site: FlowLinkSite, value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new SchemaError(site.provider, `${site.provider} returned an invalid row`);
  return value;
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/** The courier in China `OtherName` names and its number `OtherNum`, when that courier's rules offer it. */
function handoffOf(waybill: Record<string, unknown>, number: string): Handoff | null {
  const courier = typeof waybill.OtherName === 'string' ? waybill.OtherName : '';
  const onward = typeof waybill.OtherNum === 'string' && waybill.OtherNum.length <= 64 ? normalizeTrackingNumber(waybill.OtherNum) : '';
  const named = COURIERS.filter(([name]) => name.test(courier)).map(([, carrier]) => carrier);
  if (named.length !== 1 || !/^[A-Z0-9]{8,30}$/.test(onward) || onward === number
    || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

/** The waybill the reply gives for the number asked, among those it lists. */
function waybillOf(site: FlowLinkSite, payload: Record<string, unknown>, number: string): Record<string, unknown> {
  const { data } = payload;
  if (!Array.isArray(data) || data.length > MAX_WAYBILLS) throw new SchemaError(site.provider, `${site.provider} returned an invalid waybill list`);
  const own = (data as unknown[]).filter((entry): entry is Record<string, unknown> => isRecord(entry)
    && typeof entry.CNum === 'string' && entry.CNum.length <= 64 && normalizeTrackingNumber(entry.CNum) === number);
  if (own.length !== 1) throw new SchemaError(site.provider, `${site.provider} answered for another number`);
  return own[0]!;
}

/**
 * A tenant's history for one waybill, newest first, from the route's reply: `{code, msg, data}` with `code` 0 and
 * one entry per number asked, `{CNum, OtherName, OtherNum, list, ErrorCode, ...}`. `ErrorCode` `NotExistsCNum` on
 * the number asked is the system's only answer for a number it does not know. The rows come oldest first, each a
 * wall clock without a zone, a text and a code (`CNCode`); every row is read on the tenant's zone, and a zone that
 * would date a row after the lookup leaves it its wall clock alone. The recipient's name, address and phone
 * digits beside the rows are never read. The courier in China `OtherName` names becomes the delivery carrier,
 * with `OtherNum`.
 */
export function parseFlowLink(site: FlowLinkSite, body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeFlowLinkNumber(site, raw);
  const reply = body.replace(/^\uFEFF/, '').trim();
  let payload: unknown;
  try {
    payload = JSON.parse(reply);
  } catch {
    if (CHALLENGE.test(reply.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    throw new SchemaError(site.provider, `${site.provider} returned a reply that is not its tracking JSON`);
  }
  if (!isRecord(payload) || !('code' in payload)) throw new SchemaError(site.provider, `${site.provider} returned an invalid reply`);
  // Any other code is the system's own failure, such as an exception it reports with code 500.
  if (payload.code !== 0) throw new IndeterminateError(site.provider, `${site.provider} did not complete the lookup`);
  const waybill = waybillOf(site, payload, number);
  const list = waybill.list ?? [];
  if (!Array.isArray(list) || list.length > MAX_ROWS) throw new SchemaError(site.provider, `${site.provider} returned an invalid history`);
  const error = text(site, waybill.ErrorCode, 60).trim();
  if (error === NOT_FOUND) {
    if (list.length) throw new SchemaError(site.provider, `${site.provider} returned rows for a number it does not know`);
    throw new NotFoundError(site.provider, `${site.provider} has no waybill under this number`);
  }
  if (error) throw new IndeterminateError(site.provider, `${site.provider} did not complete the lookup`);
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry)) throw new SchemaError(site.provider, `${site.provider} returned an invalid row`);
    const local = wallClock(site, entry.time);
    const code = clean(text(site, entry.CNCode, 60), 60);
    const description = flowlinkText(text(site, entry.context, 2000));
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const place = PLACE.exec(description);
    const location = clean(place?.[1] ?? place?.[2], 20);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: site.zone }));
    const staged = flowlinkStage(site, description, code);
    read.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: site.zone, time_zone_basis: site.zoneBasis } : {}),
      local_time: local, ...(location ? { location } : {}), description, ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(site.provider);
  // The system lists the rows in the order they happened; that order stands.
  const events = read.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, site.statusMap);
  const stage = lead?.stage as Stage | undefined;
  const handoff = handoffOf(waybill, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(handoff ? { destination_country: 'CN', delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}

/** One lookup: the page's request, then the reply read for the number. Only HTTP 200 is an answer. */
export async function flowlinkLookup(site: FlowLinkSite, number: string, options: { signal: AbortSignal; timeoutMs: number;
  fetcher?: typeof fetch; userAgent?: string }): Promise<CarrierResult> {
  // IIS refuses a POST without a length; an empty body sends `Content-Length: 0`.
  const { response, bytes } = await fetchBounded(flowlinkLookupUrl(site, number), {
    method: 'POST', body: '', headers: flowlinkHeaders(site, options.userAgent), signal: options.signal }, {
    provider: site.provider, fetcher: options.fetcher, maxBytes: FLOWLINK_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)),
    redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 405, 410, 411],
  });
  if (response.status !== 200) {
    if (response.status === 403 && CHALLENGE.test(decodeText(bytes).slice(0, 64_000))) {
      throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    }
    throw new TransportError(site.provider, `${site.provider} tracking lookup is unavailable`, { status: response.status });
  }
  return parseFlowLink(site, decodeText(bytes), number);
}

/** A tenant's tracker: one lookup, and one more when the first fails to reach the system or hangs. */
export class FlowLinkTracker {
  constructor(private readonly site: FlowLinkSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeFlowLinkNumber(this.site, raw);
    const read = (signal: AbortSignal, timeoutMs: number) => flowlinkLookup(this.site, number,
      { signal, timeoutMs, fetcher: this.options.fetcher, userAgent: this.options.userAgent });
    // The first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.site.carrier, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** A tenant's adapter. */
export function flowlinkAdapter(site: FlowLinkSite): AdapterFactory {
  return (environment) => {
    const tracker = new FlowLinkTracker(site, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: site.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => normalizeFlowLinkNumber(site, number))),
    };
  };
}
