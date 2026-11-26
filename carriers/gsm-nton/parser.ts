import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { expresswebCodeStage, expresswebWordingStage } from './status.js';

/** A forwarder on expressWeb: its catalog id, its name and the `fwdCode` its tracking links carry. */
export interface ExpresswebTenant {
  provider: string;
  name: string;
  fwdCode: string;
}

/** The replies of one lookup: the bill's bound, its header and its event list. */
export interface ExpresswebReplies {
  bound: unknown;
  header: unknown;
  events: unknown;
}

// Each reply is a few kilobytes; the event list is asked for its first hundred rows.
export const EXPRESSWEB_MAX_BYTES = 256 * 1024;
export const EXPRESSWEB_MAX_ROWS = 100;

/**
 * The tables of each bound, as the tracing page's script names them: air or ocean, import into
 * Korea or export from it. The page sends any other bound to the ocean export tables.
 */
export const EXPRESSWEB_BOUNDS = {
  AI: { tableName: 'WTEDAI_STATUS', tableNameHbl: 'WTEDAI_HBL', tableCSNameHbl: 'TEDAI_HBL', tableNameAdd: 'TEDAI_HBL_Additional', FlightNo: 'Y' },
  AO: { tableName: 'WTEDAO_STATUS', tableNameHbl: 'WTEDAO_HBL', tableCSNameHbl: 'TEDAO_HBL', FlightNo: 'Y' },
  OI: { tableName: 'WTEDOI_STATUS', tableNameHbl: 'WTEDOI_HBL', tableCSNameHbl: 'TEDOI_HBL', tableNameAdd: 'TEDOI_HBL_Additional', VesselName: 'Y' },
  OO: { tableName: 'WTEDOO_STATUS', tableNameHbl: 'WTEDOO_HBL', tableCSNameHbl: 'TEDAO_HBL', VesselName: 'Y' },
} as const satisfies Record<string, Record<string, string>>;
export type ExpresswebBound = keyof typeof EXPRESSWEB_BOUNDS;
const IMPORTS: ReadonlySet<string> = new Set<ExpresswebBound>(['AI', 'OI']);

// A house bill number, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,20}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// The header's clock of the bill's current status: "2024-10-07 12:45".
const STAMP = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)$/;
const CODE = /^[A-Z][A-Z0-9]{1,7}(?:_[A-Z0-9]{1,4})?$/;
// A departure or an arrival ends with its airport or port: "Departure(MXP)".
const PORT = /\(([A-Z]{3}|[A-Z]{5})\)$/;
// Korea Post's own record of a scan, which the delivering carrier's rows carry as their remark:
// the office, a code, then the scan, who took the parcel and the postman. Only the office is kept.
const POST_OFFICE = /^([가-힣]{1,20}(?:우체국|우편집중국|우편물류센터))\d{3}/;
// The delivering carriers the tracing page opens a bill's delivery in, by its delivery code.
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['EMS', 'korea-post'], ['KOREX', 'cj-logistics'], ['HANJIN', 'hanjin'], ['LOGEN', 'logen'], ['CHUNIL', 'chunil'],
]);
// A delivering carrier's number, as a changed delivery names it.
const PARTNER_NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;

/** A house bill number for a forwarder's expressWeb tracker. */
export function normalizeExpresswebNumber(raw: string, { provider, name }: ExpresswebTenant): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `Enter the ${name} bill number, in letters and digits`);
  return number;
}

const invalid = (provider: string, message: string): never => {
  throw new SchemaError(provider, message);
};

/** A text field of a reply, trimmed: the replies give an absent field as null, or leave it out. */
function textOf(value: unknown, provider: string): string {
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : invalid(provider, 'expressWeb returned a field that is not text');
}

/** A reply's `data`: the string "null" when the tracker has nothing under the number. */
function dataOf(payload: unknown, provider: string): unknown {
  if (!isRecord(payload) || !('data' in payload)) return invalid(provider, 'expressWeb returned an unreadable reply');
  return payload.data;
}

const sameBill = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value) === number;

/**
 * The bound of the bill under a number, which names the tables its header and events sit in.
 * `{"data":"null"}` is the tracker's answer for a number it has no bill under.
 */
export function expresswebBound(payload: unknown, number: string, { provider, name }: ExpresswebTenant): ExpresswebBound {
  const data = dataOf(payload, provider);
  if (data === 'null') throw new NotFoundError(provider, `${name} has no bill under this number`);
  if (!isRecord(data) || typeof data.bound !== 'string') return invalid(provider, 'expressWeb returned an invalid bound');
  if (!sameBill(data.HBLNO, number)) throw new IndeterminateError(provider, `${name} answered for another bill`);
  return Object.hasOwn(EXPRESSWEB_BOUNDS, data.bound) ? data.bound as ExpresswebBound : invalid(provider, 'expressWeb returned a bound it does not list');
}

/** The header of the bill, which the event list asks for by its reference. */
export function expresswebHeader(payload: unknown, number: string, { provider, name }: ExpresswebTenant): { fields: Record<string, unknown>; reference: string } {
  const data = dataOf(payload, provider);
  // The bound named the bill, so a header without it is no answer about the parcel.
  if (data === 'null') throw new IndeterminateError(provider, `${name} named the bill's bound but returned no bill`);
  if (!isRecord(data)) return invalid(provider, 'expressWeb returned an invalid bill');
  if (!sameBill(data.HBLNO, number)) throw new IndeterminateError(provider, `${name} answered for another bill`);
  return { fields: data, reference: textOf(data.REFNO, provider) };
}

/** The rows of the event list, in the jqGrid form the tracing page reads: `{total, records, page, rows}`. */
function rowsOf(payload: unknown, provider: string): { rows: Record<string, unknown>[]; records: number } {
  if (!isRecord(payload) || !Array.isArray(payload.rows) || payload.rows.length > EXPRESSWEB_MAX_ROWS) {
    return invalid(provider, 'expressWeb returned an invalid event list');
  }
  const rows = payload.rows.map((row) => (isRecord(row) ? row : invalid(provider, 'expressWeb returned an invalid event')));
  const records = typeof payload.records === 'number' && Number.isInteger(payload.records) ? payload.records : rows.length;
  return { rows, records };
}

/** A row's wall clock: the tracker gives no zone, so it stays the station's own. */
function wallClock(day: string, time: string, provider: string): string {
  const date = DAY.exec(day);
  const iso = date && Number(date[1]) > 2000 ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
  if (!iso) return invalid(provider, 'expressWeb returned an invalid event date');
  if (!time) return iso;
  const clock = CLOCK.exec(time) ?? invalid(provider, 'expressWeb returned an invalid event time');
  return `${iso}T${clock[1]}:${clock[2]}:00`;
}

type Scan = CarrierEvent & { local_time: string; description: string; provider_code: string };

function scanOf(row: Record<string, unknown>, provider: string): Scan {
  const code = textOf(row.STATUSCODE, provider);
  if (!CODE.test(code)) invalid(provider, 'expressWeb returned an invalid status code');
  const local = wallClock(textOf(row.CONFIRMDATE, provider), textOf(row.CONFIRMTIME, provider), provider);
  const wording = textOf(row.STATUSNAME, provider);
  // The place a row names: the airport or port of a flight or sailing, or the post office of a
  // Korea Post scan. Other rows say nothing of where they were written.
  const location = PORT.exec(wording)?.[1] ?? POST_OFFICE.exec(textOf(row.CONFIRMREMARK, provider))?.[1];
  const stage = expresswebCodeStage(code);
  return {
    local_time: local, description: wording || textOf(row.DESCRIPTION, provider) || code, provider_code: code,
    ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

/**
 * The delivering carrier and its number, as the tracing page opens their tracker: a changed
 * delivery's own number, else the bill's number with the delivery code of the bill.
 */
function handoffOf(header: Record<string, unknown>, number: string, provider: string): { delivery_carrier?: string; delivery_tracking_number?: string } {
  // A delivery's code, or its name when it has no code: an English reply names Korea Post "우체국(EMS)".
  const partnerOf = (code: unknown, name: unknown) => {
    const text = textOf(code, provider).toUpperCase();
    return text ? PARTNERS.get(text) : PARTNERS.get(/\(([A-Z]+)\)$/.exec(textOf(name, provider).toUpperCase())?.[1] ?? '');
  };
  const changed = textOf(header.ChangeDeliveryNo, provider);
  if (changed) {
    // A delivery split between several numbers names none of them as the parcel's.
    const numbers = changed.split(',').map((value) => normalizeTrackingNumber(value)).filter(Boolean);
    const partner = partnerOf(header.ChangeDeliveryCode, header.ChangeDeliveryName);
    return partner && numbers.length === 1 && PARTNER_NUMBER.test(numbers[0]!)
      ? { delivery_carrier: partner, delivery_tracking_number: numbers[0]! } : {};
  }
  if (textOf(header.ChangeDeliveryCode, provider)) return {};
  const partner = partnerOf(header.DeliveryCode, header.DeliveryName);
  return partner && /^\d{8,20}$/.test(number) ? { delivery_carrier: partner, delivery_tracking_number: number } : {};
}

/**
 * Reads one bill: its rows, newest first, on their stations' wall clocks, with the airport of a
 * flight and the post office of a Korea Post scan as their places. The shipper, consignee, weight,
 * order number and remarks stay behind.
 */
export function parseExpressweb(replies: ExpresswebReplies, raw: string, tenant: ExpresswebTenant): CarrierResult {
  const { provider, name } = tenant;
  const number = normalizeExpresswebNumber(raw, tenant);
  const bound = expresswebBound(replies.bound, number, tenant);
  const { fields: header } = expresswebHeader(replies.header, number, tenant);
  const { rows, records } = rowsOf(replies.events, provider);
  const handoff = handoffOf(header, number, provider);
  const destination = IMPORTS.has(bound) ? { destination_country: 'KR' } : {};

  const seen = new Set<string>();
  const events = rows.map((row, index) => ({ index, scan: scanOf(row, provider) })).filter(({ scan }) => {
    const key = JSON.stringify([scan.local_time, scan.provider_code, scan.description, scan.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.scan.local_time.localeCompare(a.scan.local_time) || b.index - a.index).map(({ scan }) => scan);

  if (!events.length) {
    // A bill without rows still has the header's current status.
    const status = textOf(header.STATUSNAME, provider);
    if (!status) {
      throw new NoHistoryError(provider, `${name} lists the bill without its progress`, { reason: 'listed',
        ...(handoff.delivery_carrier ? { deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number } : {}) });
    }
    const stamp = STAMP.exec(textOf(header.CONFIRMDATE, provider));
    const stage = expresswebWordingStage(status);
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: status, last_update: null,
      ...(stamp ? { last_update_local: wallClock(stamp[1]!, stamp[2]!, provider) } : {}),
      expected_delivery: null, ...destination, ...handoff, summary_only: true, events: [],
    };
  }
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    ...destination,
    ...handoff,
    events,
    // The list holds the oldest rows first, so the newest are the ones missing.
    ...(records > rows.length ? { history_truncated: true } : {}),
  };
}
