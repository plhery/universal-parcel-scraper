/**
 * kdfei.cn's forwarding platform. The forwarders on it track their waybills through one service, told apart by
 * the tenant code their waybill page sends as `param`; a tenant brings its code, its site, the zones of its
 * warehouses and its status map (`kdfeiStatusMap()` in `kdfeiStatus.ts`), and `kdfeiAdapter()` does the rest.
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

/** The service every tenant's waybill page asks. */
export const KDFEI_API = 'https://api.kdfei.cn/api/getwlbill_web';
// A waybill's rows come to a few kilobytes.
const KDFEI_MAX_BYTES = 512 * 1024;
const CHINA = 'Asia/Shanghai';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;
// The page strips spaces and sends what is left; the samples are letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "2025-08-07 05:00:12": the wall clock the platform writes, without a zone.
const CLOCK = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/;
// The steps in China: the arrival at the port of entry and customs.
const CHINA_STATE = /到达国内|清关/u;
const CHINA_TEXT = /到达国内|中国口岸|清关|国内物流/u;
// Couriers in China a waybill may hand the parcel to, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'],
];
// A clause that names a person or gives a phone. A number after 单号 is a waybill and stays.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|快递员|快递小哥|投递员|揽投员|派送员|派件员|收派员|配送员|业务员|司机|姓名|签收人|代收人|收件人|收货人|交给|(?<![A-Z\d])(?<!单号为?\s*[:：]?\s*)\d{7,}/iu;
// "他人代收：…": who took the parcel in, named or placed after the colon.
const SIGNED = /^(\s*[^,，;；:：]{0,12}?(?:签收|代收))\s*[:：]/u;
const BRACKETED = /[（(][^（）()]{0,200}[）)]/gu;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

export { kdfeiStatusMap, type KdfeiEntry } from './kdfeiStatus.js';

export interface KdfeiSite {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The tenant code the site's waybill page sends as `param`. */
  readonly tenant: string;
  /** The site's waybill page, sent as Referer. */
  readonly page: string;
  /** The zone of each warehouse, by the city `startcity` names. */
  readonly warehouses: Readonly<Record<string, string>>;
  readonly statusMap: CarrierStatusMap;
}

/** A waybill on a kdfei tenant's tracker, without spaces or hyphens. */
export function normalizeKdfeiNumber(site: KdfeiSite, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(site.provider, `${site.provider} waybills are 6 to 30 letters and digits`);
  return number;
}

/** The waybill page's request: the tenant code and the number, as a form. */
export function kdfeiRequest(site: KdfeiSite, number: string, signal: AbortSignal, userAgent?: string): RequestInit {
  const page = new URL(site.page);
  return { method: 'POST', signal, body: new URLSearchParams({ param: site.tenant, searchkey: number }).toString(), headers: {
    Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: page.origin,
    Referer: `${page.origin}${page.pathname}?${new URLSearchParams({ order: number })}`, 'User-Agent': userAgentOf(userAgent),
  } };
}

/**
 * A row's text without the people and phones it names: a bracket that gives a contact goes, then every clause
 * that names a courier, a signer or a phone. Who took a parcel in keeps the words that say so.
 */
export function kdfeiText(value: string): string {
  const text = value.replace(/<[^>]*>/gu, ' ').replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  const kept: string[] = [];
  for (const clause of text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u)) {
    const signed = SIGNED.exec(clause);
    if (signed) kept.push(signed[1]!);
    else if (!CONTACT.test(clause)) kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's stage, by the tenant's map, else by the shared wording rules on its text and then its state, or none. */
export function kdfeiStage(site: KdfeiSite, description: string, state: string): ClassifiedWording | null {
  const stage = site.statusMap.stage(state || null, normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  for (const text of [description, state]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

function wallClock(site: KdfeiSite, value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match
    ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}T${match[4]!.padStart(2, '0')}:${match[5]}:${match[6]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(site.provider, `${site.provider} returned an invalid row time`);
  }
  return local;
}

function text(site: KdfeiSite, value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new SchemaError(site.provider, `${site.provider} returned an invalid row`);
  return value;
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/** The courier in China `expresscom` names and its number `expressid`, when that courier's rules offer it. */
function handoffOf(waybill: Record<string, unknown>, number: string): Handoff | null {
  const courier = typeof waybill.expresscom === 'string' ? waybill.expresscom : '';
  const onward = typeof waybill.expressid === 'string' && waybill.expressid.length <= 64 ? normalizeTrackingNumber(waybill.expressid) : '';
  const named = COURIERS.filter(([name]) => name.test(courier)).map(([, carrier]) => carrier);
  if (named.length !== 1 || !/^[A-Z0-9]{8,30}$/.test(onward) || onward === number
    || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

/**
 * A tenant's history for one waybill, newest first, from the service's reply: HTTP 200 with an empty body for a
 * number the tenant does not know, else `{state, pkval, startcity, endcity, expresscom, expressid, phone, list}`
 * with the rows newest first, each a text, the platform's state and a wall clock without a zone. The rows until
 * the parcel reaches China are on the clock of the warehouse `startcity` names, when the tenant knows its zone,
 * else they keep their wall clock alone; from the arrival in China on, they are on China's clock. A zone that
 * would date a row after the lookup leaves it its wall clock alone. `phone` is never read. The courier in China
 * `expresscom` names becomes the delivery carrier, with `expressid`.
 */
export function parseKdfei(site: KdfeiSite, body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeKdfeiNumber(site, raw);
  const reply = body.replace(/^\uFEFF/, '').trim();
  // The service's only answer for a number it does not know; the page shows 查询异常 for it.
  if (!reply) throw new NotFoundError(site.provider, `${site.provider} has no waybill under this number`);
  let payload: unknown;
  try {
    payload = JSON.parse(reply);
  } catch {
    if (CHALLENGE.test(reply.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    throw new SchemaError(site.provider, `${site.provider} returned a reply that is not its tracking JSON`);
  }
  if (!isRecord(payload) || !('state' in payload)) throw new SchemaError(site.provider, `${site.provider} returned an invalid reply`);
  // The page shows `message` for any other state.
  if (String(payload.state).trim() !== '1') throw new IndeterminateError(site.provider, `${site.provider} did not complete the lookup`);
  if (typeof payload.pkval !== 'string' || normalizeTrackingNumber(payload.pkval) !== number) {
    throw new SchemaError(site.provider, `${site.provider} answered for another number`);
  }
  const list = payload.list ?? [];
  if (!Array.isArray(list) || list.length > MAX_ROWS) throw new SchemaError(site.provider, `${site.provider} returned an invalid history`);
  const rows = (list as unknown[]).map((entry) => {
    if (!isRecord(entry)) throw new SchemaError(site.provider, `${site.provider} returned an invalid row`);
    return { local: wallClock(site, entry.createtime), state: clean(text(site, entry.state, 60), 60),
      context: text(site, entry.context, 1000) };
  }).reverse();
  const arrival = rows.findIndex((entry) => CHINA_STATE.test(entry.state) || CHINA_TEXT.test(entry.context));
  const city = typeof payload.startcity === 'string' ? payload.startcity.trim() : '';
  const warehouse = Object.hasOwn(site.warehouses, city) ? site.warehouses[city] : undefined;
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const [index, entry] of rows.entries()) {
    const description = kdfeiText(entry.context) || entry.state;
    if (!description) continue;
    const key = JSON.stringify([entry.local, entry.state, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const china = arrival >= 0 && index >= arrival;
    const zone = china ? CHINA : warehouse;
    const instant = zone ? firstOccurrence(DateTime.fromISO(entry.local, { zone })) : null;
    const dated = instant && instant.toMillis() <= readAt + CLOCK_SKEW_MS;
    const staged = kdfeiStage(site, description, entry.state);
    read.push({
      ...(dated ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: china ? 'destination' : 'place' } : {}),
      local_time: entry.local, description, ...(entry.state ? { provider_code: entry.state } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(site.provider);
  // The service lists the rows in the order they happened, across zones; that order stands.
  const events = read.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, site.statusMap);
  const stage = lead?.stage as Stage | undefined;
  const handoff = handoffOf(payload, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(arrival >= 0 || handoff ? { destination_country: 'CN' } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}

/** One lookup: the page's form, then the reply read for the number. Only HTTP 200 is an answer. */
export async function kdfeiLookup(site: KdfeiSite, number: string, options: { signal: AbortSignal; timeoutMs: number;
  fetcher?: typeof fetch; userAgent?: string }): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(KDFEI_API, {
    ...kdfeiRequest(site, number, options.signal, options.userAgent), signal: options.signal }, {
    provider: site.provider, fetcher: options.fetcher, maxBytes: KDFEI_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)),
    redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 405, 410],
  });
  if (response.status !== 200) throw new TransportError(site.provider, `${site.provider} tracking lookup is unavailable`, { status: response.status });
  return parseKdfei(site, decodeText(bytes), number);
}

/** A tenant's tracker: one lookup, and one more when the first fails to reach the service or hangs. */
export class KdfeiTracker {
  constructor(private readonly site: KdfeiSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKdfeiNumber(this.site, raw);
    const read = (signal: AbortSignal, timeoutMs: number) => kdfeiLookup(this.site, number,
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
export function kdfeiAdapter(site: KdfeiSite): AdapterFactory {
  return (environment) => {
    const tracker = new KdfeiTracker(site, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: site.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => normalizeKdfeiNumber(site, number))),
    };
  };
}
