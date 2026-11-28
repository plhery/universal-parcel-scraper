/**
 * DsyExpress, the PHP forwarding platform whose sites end their titles in "Powered by DsyExpress!". Each tenant
 * answers a waybill on its own host; a tenant brings its host, its status map (`dsyStatusMap()` in
 * `dsyexpressStatus.ts`) and the zones of the places its line-haul rows name, and `dsyAdapter()` does the rest.
 */
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { clean } from '../../core/transport/text.js';
import { dsyStage } from './dsyexpressStatus.js';

export { dsyStatusMap, dsyTemplate, type DsyStatusEntry } from './dsyexpressStatus.js';

// A waybill's page comes to a few dozen kilobytes.
const DSY_MAX_BYTES = 512 * 1024;
// The platform's server writes its own rows on China's clock.
const CHINA = 'Asia/Shanghai';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tenants' servers are slow to answer from abroad at times.
const DEFAULT_BUDGET_MS = 20_000;
// Letters and digits, with a digit: OE, SDL or nothing before the digits on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "2026-10-30 09:38:00": the wall clock a row is written with, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The platform's answer for a number it holds nothing under, on its tips page.
const NOT_FOUND = '运单信息不存在';
const TIPS_TITLE = /^友情提示 - .*Powered by DsyExpress!$/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

// A phone: a mobile, whole or masked, a landline with its area code, a courier's hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|1[3-9]\d[*＊]{4}\d{4}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/gu;
// Words that introduce a person or a contact: a phone, a hotline, a courier, a signer, an address.
const CONTACT = new RegExp(`电话|手机|致电|联系|电联|热线|投诉|呼叫|姓名|司机|业务员|快递员|快递小哥|投递员|揽投员|派送员|派件员|揽收员|收派员|配送员|签收人|代收人|收件人|收货人|地址|${PHONE.source}`, 'u');
// The courtesy a courier's row ends on.
const AFTERWORD = /^(?:如有|如遇|如需|如您|若有|关注|感谢|猜您|可更直接|无需找|获取实时|您的体验|您的期待|有事呼叫)/u;
const ROLES = '业务员|快递员|快递小哥|派件员|揽收员|收派员|派送员|配送员|投递员';
// A name before a mobile in brackets, after a branch, a role, a bracket, a colon or a space: "…公司-<name>(<mobile>)".
const NAMED = /(?<=^|[\s）)】:：]|[部点站司厅心店仓员哥])-?\p{Script=Han}{2,4}[（(]\s*1[3-9]\d{9}\s*[)）]/gu;
// "派件员【<name>】": a courier named in a bracket after the role.
const ROLE_BRACKET = new RegExp(`(?:的)?(?:${ROLES})\\s*[:：]?\\s*【[^【】]{1,30}】`, 'gu');
// A role whose name went with its phone, before what the courier does: "快递员 正在为您派送". A role before a name stays,
// so the clause goes.
const ROLE = new RegExp(`(?:的)?(?:${ROLES})\\s*(?=正在|已|为您|$|[，,。；;])`, 'gu');
// "快件交给【<courier>，联系电话：…】，正在派送途中": the courier the parcel was handed to.
const HANDED_TO = /交给【[^【】]*】[，,]?/gu;
// "【<station>，地址：…】": a station's address after its name.
const STATION_ADDRESS = /【([^【】，,]{1,40})[，,]\s*地址\s*[:：][^【】]*】/gu;
// "暂存至<where>丰巢柜": the locker or point a parcel waits in, by where it stands.
const PICKUP = /(暂存至|暂存在|已放入|放入|存放至|已投递至|投递至|投递到|已到)[^，,。；;【】]{1,40}?(丰巢柜|快递柜|智能柜|快件柜|菜鸟驿站|驿站|代收点|自提点|服务站|快递超市)/gu;
// "，<name> 已签收", "已被 <name> 签收": who signed for the parcel, by name.
const SIGNER = /(?<=^|[，,】])\s*\p{Script=Han}{2,4}\s+(?=已签收)|(?<=已被)\s*\p{Script=Han}{2,4}\s*(?=签收)/gu;
const BRACKETED = /【[^【】]*】/gu;
const SQUARE = /\[[^[\]]*\]/gu;
const PARENTHESIZED = /[（(][^（）()]*[)）]/gu;
// "北京市|北京市【…】": the town a relayed courier's row opens with, before a bar.
const TOWN_PREFIX = /^([^|｜【】，,]{1,20})\s*[|｜]\s*/u;
// "【上海市】已到达 …": the town a relayed courier's row opens with, in a bracket.
const TOWN_BRACKET = /^【(\p{Script=Han}{2,10}[市县州盟区])】/u;
// "【美国 - 纽约】…", "到达：【中国 - 西安】…": the country and the town a line-haul row names.
const LINE_HAUL_PLACE = /^(?:到达\s*[:：]\s*)?【\s*([^【】\s-]{1,10})\s+-\s+([^【】]{1,20}?)\s*】/u;
// A row that is one bracket and nothing else: the line-haul feed's, without a place.
const LINE_HAUL_ALONE = /^【[^【】]+】$/u;
// The courier in China and its number, in the history's header: "物流状态（百世快递：…）", "物流信息(韵达:…)".
const HEADER_HANDOFF = /[（(]\s*([^：:（）()]{1,20}?)\s*[：:]\s*([A-Za-z0-9]{6,30})\s*[）)]/u;
// The courier in China and its number, in a row: "顺丰速运已揽件单号:…", "百世快递已揽件，快递单号:…".
const ROW_HANDOFF = /^(\S{2,10}?)(?:\s*已揽件|\s*已收件|\s*已揽收)[，,]?\s*(?:快递)?单号\s*[:：]\s*([A-Za-z0-9]{8,30})$/u;
// Couriers in China a waybill may hand the parcel to, as Chinese names them, with the catalog's id where it has one.
const COURIERS: readonly (readonly [RegExp, string | null])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'], [/百世/u, null], [/天天/u, null],
];
// The steps in China: clearance and the domestic network.
const CHINA_TEXT = /清关|口岸|落地国内|国内运输|中国/u;
const US_TEXT = /美国/u;

export interface DsySite {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The tenant's host, such as `www.overseaex.com`. */
  readonly host: string;
  readonly statusMap: CarrierStatusMap;
  /** The zone of each place a line-haul row names as "<country> - <town>"; China's need not be listed. */
  readonly places?: Readonly<Record<string, string>>;
}

/** A waybill on a DsyExpress tenant's tracker, without spaces or hyphens. */
export function normalizeDsyNumber(site: DsySite, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(site.provider, `${site.provider} waybills are 6 to 30 letters and digits`);
  return number;
}

/** The tenant's search, as its tracking box sends it. */
export function dsyLookupUrl(site: DsySite, number: string): string {
  return `https://${site.host}/index.php?${new URLSearchParams({ c: 'index', f: 'search', sn: number })}`;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/**
 * A row's text without the people, phones and addresses it names, and the courtesy after them:
 * "【上海市】上海青浦区新城公司 正在为您派送" from a relayed courier's row that names the courier with a mobile
 * and the branch with a landline. A locker keeps its kind without where it stands.
 */
export function dsyText(raw: string): string {
  const text = clean(raw, 2000).replace(STATION_ADDRESS, '【$1】')
    .replace(HANDED_TO, (part) => (CONTACT.test(part) ? '' : part))
    .replace(NAMED, '')
    .replace(ROLE_BRACKET, '')
    .replace(BRACKETED, (part) => (CONTACT.test(part) ? '' : part))
    .replace(SQUARE, (part) => (CONTACT.test(part) ? '' : part))
    .replace(PARENTHESIZED, (part) => (CONTACT.test(part) || AFTERWORD.test(part.slice(1)) ? '' : part))
    .replace(PICKUP, '$1$2')
    .replace(SIGNER, '')
    .replace(ROLE, '');
  const kept: string[] = [];
  for (const clause of text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u)) {
    const words = clause.trim();
    if (AFTERWORD.test(words)) break;
    if (!CONTACT.test(words)) kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

interface Row {
  readonly local: string;
  readonly raw: string;
}

function wallClock(site: DsySite, value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(site.provider, `${site.provider} returned an invalid row time`);
  }
  return local;
}

/** The history's table and its header's second cell, or the tips page's answer. */
function historyOf(site: DsySite, $: CheerioAPI, body: string): { header: string; rows: Row[] } {
  const table = $('table').filter((_index, element) => {
    const heads = $(element).find('thead th').toArray().map((head) => clean($(head).text(), 60));
    return heads.length === 2 && /^(?:处理)?时间$/u.test(heads[0]!) && /^物流(?:信息|状态)/u.test(heads[1]!);
  });
  if (table.length !== 1) {
    const tips = clean($('.tips .txt').text(), 200);
    if (TIPS_TITLE.test(clean($('title').text(), 200)) && tips) {
      if (tips === NOT_FOUND) throw new NotFoundError(site.provider, `${site.provider} has no waybill under this number`);
      throw new IndeterminateError(site.provider, `${site.provider} did not complete the lookup`);
    }
    if (isChallenge(body)) throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    throw new SchemaError(site.provider, `${site.provider} returned a page that is not its tracking page`);
  }
  const header = clean(table.find('thead th').eq(1).text(), 120);
  const rows = table.find('tbody tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(site.provider, `${site.provider} returned an oversized history`);
  return { header, rows: rows.flatMap((row) => {
    const cells = $(row).children('td');
    // The note the platform adds under the rows spans both columns.
    if (cells.length === 1 && cells.attr('colspan')) return [];
    if (cells.length !== 2) throw new SchemaError(site.provider, `${site.provider} returned an invalid row`);
    return [{ local: wallClock(site, cells.eq(0).text()), raw: cells.eq(1).text() }];
  }) };
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/** A courier in China by its name, with the catalog's id where the catalog has it; undefined for any other name. */
function courierOf(name: string): string | null | undefined {
  const named = COURIERS.filter(([pattern]) => pattern.test(name));
  return named.length === 1 ? named[0]![1] : undefined;
}

/** The courier in China a name and a number give, when the number is that courier's and not the waybill's. */
function handoffFrom(name: string, raw: string, number: string): Handoff | null {
  const carrier = courierOf(name);
  const onward = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!carrier || !/^[A-Z0-9]{8,30}$/.test(onward) || onward === number
    || !(detectCarrierMatch(onward).candidates as string[]).includes(carrier)) return null;
  return { carrier, number: onward };
}

interface Placed {
  readonly description: string;
  readonly location?: string;
  readonly zone?: string;
  readonly basis?: string;
}

/**
 * Where a row was written and on which clock: a line-haul row that names a place the tenant knows, on that place's;
 * a line-haul row without a place, or with one the tenant does not know, on none; any other row on the platform's.
 */
function placeOf(site: DsySite, text: string): Placed {
  const town = TOWN_PREFIX.exec(text);
  if (town) {
    const description = text.slice(town[0].length);
    return { description: description || text, location: clean(town[1], 20), zone: CHINA, basis: 'carrier' };
  }
  const line = LINE_HAUL_PLACE.exec(text);
  if (line) {
    const place = `${line[1]} - ${clean(line[2], 20)}`;
    const zone = line[1] === '中国' ? CHINA : site.places && Object.hasOwn(site.places, place) ? site.places[place] : undefined;
    return { description: text, location: place, ...(zone ? { zone, basis: 'place' } : {}) };
  }
  if (LINE_HAUL_ALONE.test(text)) return { description: text };
  const bracket = TOWN_BRACKET.exec(text)?.[1];
  return { description: text, ...(bracket ? { location: bracket } : {}), zone: CHINA, basis: 'carrier' };
}

function dated(local: string, placed: Placed, readAt: number): Partial<CarrierEvent> {
  if (!placed.zone) return {};
  const instant = firstOccurrence(DateTime.fromISO(local, { zone: placed.zone }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: placed.zone, time_zone_basis: placed.basis! } : {};
}

/**
 * A tenant's history for one waybill, newest first, from its search page: a table of a wall clock and a text per
 * row, newest first, with the rows of the courier in China merged in, or the platform's tips page, whose
 * 运单信息不存在 is the only not-found. The page does not name the number it answered for. The platform writes its
 * own rows on its server's clock, China's, and the couriers in China theirs on the same; the rows of the
 * line-haul feed that name "<country> - <town>" are on that town's clock when the tenant knows its zone, and the
 * feed's rows without a place keep their wall clock alone. A clock that would date a row after the lookup keeps
 * its wall clock alone. The header or the courier's pickup row names the courier in China with its number.
 */
export function parseDsy(site: DsySite, body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDsyNumber(site, raw);
  const { header, rows } = historyOf(site, load(body), body);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let handoff: Handoff | null = null;
  let named = false;
  let china = false;
  let us = false;
  const fromHeader = HEADER_HANDOFF.exec(header);
  if (fromHeader) {
    named = courierOf(fromHeader[1]!) !== undefined;
    handoff = handoffFrom(fromHeader[1]!, fromHeader[2]!, number);
  }
  for (const row of rows) {
    const text = dsyText(row.raw);
    if (!text) continue;
    const pickup = ROW_HANDOFF.exec(text);
    if (pickup && courierOf(pickup[1]!) !== undefined) {
      named = true;
      handoff ??= handoffFrom(pickup[1]!, pickup[2]!, number);
    }
    const placed = placeOf(site, text);
    const key = JSON.stringify([row.local, placed.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (CHINA_TEXT.test(placed.description)) china = true;
    if (US_TEXT.test(placed.description)) us = true;
    const staged = dsyStage(site.statusMap, placed.description);
    events.push({
      ...dated(row.local, placed, readAt),
      local_time: row.local,
      ...(placed.location ? { location: placed.location } : {}),
      description: placed.description,
      ...(placed.description !== text ? { original_description: text } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(site.provider);
  const latest = events[0]!;
  const lead = leadingScan(events, site.statusMap);
  const stage = lead?.stage as Stage | undefined;
  const destination = china || named ? 'CN' : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(us && destination ? { origin_country: 'US' } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}

/** One lookup: the tenant's search page for the number. Only HTTP 200 is an answer, and no redirect is followed. */
export async function dsyLookup(site: DsySite, number: string, options: { signal: AbortSignal; timeoutMs: number;
  fetcher?: typeof fetch; userAgent?: string }): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(dsyLookupUrl(site, number), {
    signal: options.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(options.userAgent) },
  }, { provider: site.provider, fetcher: options.fetcher, maxBytes: DSY_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)),
    redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
  if (response.status !== 200) {
    if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    throw new TransportError(site.provider, `${site.provider} tracking page is unavailable`, { status: response.status });
  }
  return parseDsy(site, decodeText(bytes).replace(/^\uFEFF/, ''), number);
}

/** A tenant's tracker: one lookup, and one more when the first fails to reach the page or hangs. */
export class DsyTracker {
  constructor(private readonly site: DsySite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDsyNumber(this.site, raw);
    const read = (signal: AbortSignal, timeoutMs: number) => dsyLookup(this.site, number,
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
export function dsyAdapter(site: DsySite): AdapterFactory {
  return (environment) => {
    const tracker = new DsyTracker(site, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: site.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => normalizeDsyNumber(site, number))),
    };
  };
}
