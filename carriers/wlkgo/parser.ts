import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, wlkgoStage } from './status.js';

export const PROVIDER = 'WLKGO';
export const CARRIER = 'wlkgo';
// An order's packages and rows are a few kilobytes.
export const WLKGO_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: SO, the date and a sequence for an order, or a package's number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const ZONE = 'Asia/Shanghai';
// The service's answer for a number it holds nothing under: "暂无包裹信息，请稍候再试！".
const NO_PACKAGE = /^暂无包裹信息/u;
// "2024-03-13 12:33:01": the clock the system writes, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A link to the picture of the signature, which the page opens in a viewer.
const PHOTO_LINK = /<a\b[^>]*>[\s\S]*?<\/a>/giu;
const TAG = /<[^>]*>/gu;
// The courier or the person who signed, named after a label, and a phone with or without one.
const PERSON = /[,，;；]?\s*(?:配送员|快递员|派送员|司机|签收人|收货人|联系人)(?:为)?\s*[:：]\s*[^,，;；\s]*/gu;
const PHONE = /[,，;；]?\s*(?:(?:联系)?(?:电话|手机)(?:号码)?\s*[:：]?\s*)?(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)/gu;
const PHONE_LABEL = /[,，;；]?\s*(?:联系)?(?:电话|手机)(?:号码)?\s*[:：]\s*$/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_PACKAGES = 50;
const MAX_ROWS = 200;

/** An order or package number on WLKGO's tracker, without spaces or hyphens. */
export function normalizeWlkgoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'WLKGO numbers are 6 to 40 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

/**
 * A row's text without the courier, the signer, phones or the link to the signature's picture:
 * "【古荡站】已出库,配送中" from a text that goes on to name the courier and a phone.
 */
export function wlkgoAction(action: string): string {
  const text = action.replace(PHOTO_LINK, ' ').replace(TAG, ' ').replace(/&nbsp;/gu, ' ').replace(PERSON, '').replace(PHONE, '')
    .replace(PHONE_LABEL, '');
  return clean(text, 300).replace(/^[,，;；\s]+|[,，;；:：\s]+$/gu, '');
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

interface Package {
  readonly number: string;
  readonly tracks: readonly unknown[];
}

function packageOf(value: unknown): Package {
  if (!isRecord(value) || typeof value.deliveryNO !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned a package without its number`);
  const number = normalizeTrackingNumber(value.deliveryNO);
  const tracks = value.tracks ?? [];
  if (!number || number.length > 64 || !Array.isArray(tracks)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid package`);
  if (tracks.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return { number, tracks };
}

/**
 * The package the number names: the one whose number it is, else an order's only package. An order
 * of several packages names no one parcel.
 */
export function wlkgoPackage(payload: unknown, raw: string): Package {
  const number = normalizeWlkgoNumber(raw);
  if (!isRecord(payload) || typeof payload.result !== 'boolean' || typeof payload.keywords !== 'string') {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  }
  // The page shows the answer under the number it echoes; another number's answer is not this one's.
  if (normalizeTrackingNumber(payload.keywords) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  if (!payload.result) {
    if (typeof payload.msg === 'string' && NO_PACKAGE.test(payload.msg)) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no package under this number`);
    }
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  const listed = payload.packages ?? [];
  if (!Array.isArray(listed) || listed.length > MAX_PACKAGES) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid package list`);
  // The page says it has no package for the number yet.
  if (!listed.length) throw new NoHistoryError(PROVIDER);
  const packages = (listed as unknown[]).map(packageOf);
  const own = packages.find((entry) => entry.number === number);
  if (own) return own;
  if (packages.length > 1) throw new IndeterminateError(PROVIDER, `${PROVIDER} lists several packages under the order`, { reason: 'several_parcels' });
  return packages[0]!;
}

/**
 * WLKGO's history for one package, newest first: the reply of `PackageTrack.ashx?Act=getOrderTrackInfo`,
 * `{result, keywords, packages, msg}`, each package with its number, its carrier and its rows newest first.
 * A row gives a clock without a zone, on China's, and a text that names the warehouse or station in
 * brackets, the location. The operator, the phone and the courier the text names are left out.
 */
export function parseWlkgo(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const chosen = wlkgoPackage(payload, raw);
  const seen = new Set<string>();
  const rows: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, track] of chosen.tracks.entries()) {
    if (!isRecord(track) || (track.action !== null && track.action !== undefined && typeof track.action !== 'string')) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    const local = wallClock(track.date);
    const description = wlkgoAction(String(track.action ?? '').slice(0, 2000));
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const location = clean(/【([^】]{1,40})】/u.exec(description)?.[1] ?? '', 40);
    const staged = wlkgoStage(description);
    rows.push({ local, index, event: {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows at one clock keep the reply's order, which lists the newer first.
  const events = rows.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((row) => row.event);
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
