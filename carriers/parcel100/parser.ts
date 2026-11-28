import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parcel100CodeStage, statusMap } from './status.js';

export const PROVIDER = 'Parcel100';
export const CARRIER = 'parcel100';
// A parcel's reply is a few kilobytes.
export const PARCEL100_MAX_BYTES = 256 * 1024;

// The tracker takes the parcel number on Parcel100's label, letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The code of a row Parcel100 relays from the courier in China, in that courier's words.
const RELAYED = 0;
const MAX_PARCELS = 20;
const MAX_ROWS = 300;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A clause that names a person or gives a phone: a courier, a signer, a pickup point's phone, a hotline.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|快递员|投递员|派件员|揽收人|业务员|签收人|代收人|收件人|(?<![A-Z\d])\d{7,}/iu;
const BRACKETED = /【[^【】]{0,200}】|[（(][^（）()]{0,200}[）)]/gu;
const PLACE = /【([^【】]{1,60})】/u;

/** A parcel number for Parcel100's tracker, without spaces or hyphens. */
export function normalizeParcel100Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Parcel100 parcel numbers are 6 to 30 letters and digits');
  return number;
}

/** The reply's JSON; a bot check in its place is a challenge, anything else a changed reply. */
export function parcel100Json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`, { cause });
  }
}

/**
 * A row's text without the people and phones the courier's rows name: a bracket that gives a
 * contact goes, then every clause that names a courier or gives a phone.
 */
export function parcel100Text(value: string): string {
  const text = value.replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  // A comma inside a bracketed place ends no clause.
  const kept = text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u).filter((clause) => !CONTACT.test(clause));
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  return local;
}

/**
 * The parcel's rows, newest first as the tracker lists them. A row keeps its wall clock alone: the
 * reply states no zone, and its own rows and the courier's rows it relays need not share one.
 * Its own rows carry their code; a relayed row (code 0) is staged by its wording and its first
 * bracket names the place. A repeated row is read once.
 */
function rowsOf(logs: readonly unknown[]): CarrierEvent[] {
  if (logs.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const seen = new Set<string>();
  const read: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, log] of logs.entries()) {
    if (!isRecord(log) || typeof log.status_name !== 'string' || typeof log.status_code !== 'number'
      || !Number.isSafeInteger(log.status_code) || log.status_code < 0) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    const local = wallClock(log.created_at);
    const description = parcel100Text(log.status_name.slice(0, 2000));
    if (!description) continue;
    const relayed = log.status_code === RELAYED;
    const code = relayed ? '' : String(log.status_code);
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const place = relayed ? PLACE.exec(description)?.[1] : undefined;
    const location = place ? clean(place, 80) : '';
    const worded = relayed ? classifyWording(description, 'in_transit') : null;
    const stage = relayed ? (worded!.source === 'none' ? undefined : worded!.stage) : parcel100CodeStage(code);
    const source = relayed ? worded!.source : 'carrier_map';
    read.push({ local, index, event: {
      local_time: local, ...(location ? { location } : {}), description,
      ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: source } : {}),
    } });
  }
  return read.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((row) => row.event);
}

/**
 * One parcel's history from `common/parcel/track`, `{status, code, msg, data}`. `status` false with
 * `msg` 单号不存在 is the tracker's answer for a number it does not know; any other refusal is
 * inconclusive. `data` lists each parcel asked by its `parcel_number`, which must be the number
 * asked, with its rows in `logs`.
 */
export function parseParcel100(payload: unknown, raw: string): CarrierResult {
  const number = normalizeParcel100Number(raw);
  if (!isRecord(payload) || typeof payload.status !== 'boolean') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (!payload.status) {
    if (typeof payload.msg === 'string' && payload.msg.trim() === '单号不存在') {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
    }
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (!Array.isArray(payload.data) || payload.data.length > MAX_PARCELS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const parcel = (payload.data as unknown[]).find((entry) => isRecord(entry) && typeof entry.parcel_number === 'string'
    && normalizeTrackingNumber(entry.parcel_number) === number);
  if (!isRecord(parcel)) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  if (!Array.isArray(parcel.logs)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const events = rowsOf(parcel.logs);
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the parcel without a row`, { reason: 'listed' });
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
