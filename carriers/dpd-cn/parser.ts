import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { dpdCnRowStage, dpdCnStage, isDpdCnNotice, statusMap } from './status.js';

export const PROVIDER = 'dpd-cn';
// A parcel's reply is a few kilobytes; a parent of many pieces lists them only on request.
export const DPD_CN_MAX_BYTES = 512 * 1024;

// A DPD parcel number: fourteen digits, the first four the sending depot's.
const NUMBER = /^\d{14}$/;
// "2026-11-20 14:05:09": the scanning facility's wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_SHIPMENTS = 40;
const MAX_ROWS = 300;
// An e-mail address, or a phone number written with its country's prefix, in a notice's wording. An air waybill
// ("999-12345675") has no plus sign.
const CONTACT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w+])\+\d(?:[\s./-]?\d){7,}(?!\d)/g;
// A town written in camel case or capitals: "ShenZhen", "SHENZHEN".
const SHOUTED = /^(?:\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}+)+|\p{Lu}{4,})$/u;

/** A DPD parcel number: fourteen digits. */
export function normalizeDpdCnNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DPD China parcel numbers are fourteen digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's clock as the facility's wall clock. */
function clockOf(value: unknown): string {
  const parts = CLOCK.exec(clean(value, 40));
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('DPD China returned a scan without a readable clock');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/** A place as a town or a country name, with a town's case put right: "ShenZhen" is Shenzhen. */
export function dpdCnPlace(value: unknown): string {
  return clean(value, 120).split(' ').map((word) => (SHOUTED.test(word)
    ? `${word.charAt(0)}${word.slice(1).toLocaleLowerCase('en-US')}` : word)).join(' ');
}

/** A row's wording without an e-mail address or a phone number it may name. */
export function withoutContacts(wording: string): string {
  const cut = wording.replace(CONTACT, ' ');
  return cut === wording ? wording : clean(cut, 500).replace(/\s+([,.;:!])/g, '$1');
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('DPD China returned an unreadable scan');
  // The tracker shows `Url`, a link around the wording, in place of `Desc` when it has one; the link is not kept.
  const description = withoutContacts(clean(row.Desc, 500) || textFromHtml(row.Url, 500));
  if (!description) return invalid('DPD China returned a scan without its wording');
  const location = dpdCnPlace(row.LocationName);
  return { local_time: clockOf(row.EventTime), description, ...(location ? { location } : {}), ...stageOf(description, row.IsDelivered === true) };
}

/**
 * A scan's stage: the map's, none for a wording the map lists without one, else the tracker's delivered mark,
 * else the shared wording rules.
 */
function stageOf(description: string, delivered: boolean): Pick<CarrierEvent, 'stage' | 'stage_source'> {
  const mapped = dpdCnStage(null, description);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  if (isDpdCnNotice(description)) return {};
  if (delivered) return { stage: 'delivered', stage_source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? {} : { stage: worded.stage, stage_source: worded.source };
}

/** The shipment rows of the reply's `result`, JSON text inside the envelope. */
function rowsOf(envelope: unknown): Record<string, unknown>[] {
  if (!isRecord(envelope) || typeof envelope.success !== 'boolean') return invalid('DPD China returned an unexpected reply');
  if (envelope.unAuthorizedRequest === true) throw new ChallengeError(PROVIDER, 'DPD China refused its guest request');
  if (envelope.success !== true || (envelope.error !== null && envelope.error !== undefined)) {
    throw new IndeterminateError(PROVIDER, 'DPD China failed to answer for the number');
  }
  if (typeof envelope.result !== 'string') return invalid('DPD China returned a reply without its result');
  let result: unknown;
  try { result = JSON.parse(envelope.result); } catch (cause) { return invalid(`DPD China returned an unreadable result: ${String(cause)}`); }
  if (!isRecord(result) || !Array.isArray(result.ListHawbDetails) || result.ListHawbDetails.length > MAX_SHIPMENTS
    || !result.ListHawbDetails.every(isRecord)) return invalid('DPD China returned an unexpected result');
  return result.ListHawbDetails;
}

/**
 * The tracker's answer for one number, `GetTrackingNew` with `hawbType` `H`: an envelope whose
 * `result` is JSON text holding one row per number asked. The row must repeat the number. A row
 * marked `NotFound`, without scans, is the tracker's "No Found". Scans come newest first, each on
 * the wall clock of the facility that made it, in China or in the destination's DPD network.
 */
export function parseDpdCn(envelope: unknown, raw: string): CarrierResult {
  const number = normalizeDpdCnNumber(raw);
  const rows = rowsOf(envelope);
  const own = rows.filter((row) => normalizeTrackingNumber(clean(row.TrackingNumber, 64)) === number);
  if (!own.length) {
    if (!rows.length) return invalid('DPD China returned no row for the number');
    throw new IndeterminateError(PROVIDER, 'DPD China answered for another number');
  }
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'DPD China holds several shipments under this number');
  const row = own[0]!;
  const details = row.ListTrackingDetails ?? [];
  if (typeof row.NotFound !== 'boolean' || !Array.isArray(details) || details.length > MAX_ROWS) return invalid('DPD China returned an unexpected row');
  if (row.NotFound) {
    if (details.length) return invalid('DPD China returned scans for a number it does not find');
    throw new NotFoundError(PROVIDER, 'DPD China has no parcel under this number');
  }
  if (!details.length) throw new NoHistoryError(PROVIDER, 'DPD China lists the number without a scan', { reason: 'listed' });

  const events = details.map(scanOf);
  const lead = leadingScan(events, statusMap);
  // With no scan staged, the row's own status.
  const rowStage = lead ? undefined : dpdCnRowStage(clean(row.Status, 40));
  const stage = (lead?.stage ?? rowStage) as Stage | undefined;
  const [, to] = Array.isArray(row.FromTo) ? row.FromTo.map((name) => clean(name, 80)) : [];
  const destination = to ? countryCode(to) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : to ? { destination_country_name: to } : {}),
    events,
  };
}

/** The body of the tracker's reply: its JSON, a browser check, or a changed service. */
export function parseDpdCnReply(body: string, raw: string): CarrierResult {
  const text = body.replace(/^\uFEFF/, '');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DPD China answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'DPD China answered with a page instead of JSON', { cause });
  }
  return parseDpdCn(payload, raw);
}
