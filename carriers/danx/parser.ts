import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { danxCodeStage, danxStatusText } from './status.js';

export const PROVIDER = 'danx';
// A shipment is a few kilobytes; a label used again lists each of its shipments.
export const DANX_MAX_BYTES = 1024 * 1024;

// The tracker takes the barcode on a DANX label, or the shipment's other reference, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,40}$/;
// "03-02-2025 07:54:26": a scan's wall clock in the country of the terminal, without an offset.
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CODE = /^[A-Z][A-Z0-9]{1,7}$/;
// "ISJ - Ishøj": the terminal a scan names, by its code and town.
const TERMINAL = /^[A-Z0-9]{2,5} - \S.{0,80}$/;
// A detail row of the table's hidden column: its label in bold, then its value.
const FIELD = /<div class=['"]row['"]><div[^>]*><b>([^<]{1,40})<\/b><\/div><div[^>]*>(.*?)<\/div><\/div>/gs;
const LINE = /<br\s*\/?>/i;
const BLOCK = /(?:<br\s*\/?>\s*){2,}/i;
const MAX_ROWS = 200;
const MAX_SCANS = 300;

/** A number for DANX's tracker: the barcode on its label or the shipment's other reference. */
export function normalizeDanxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the barcode number on the DANX label');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * The table rows of one `GetShipmentDetails` reply: `{"d": "<JSON>"}`, whose JSON holds
 * DataTables' `aaData`. No row is no shipment under the number.
 */
export function danxRows(payload: unknown): string[][] {
  if (!isRecord(payload) || typeof payload.d !== 'string') return invalid('DANX returned an unreadable reply');
  let table: unknown;
  try {
    table = JSON.parse(payload.d);
  } catch (error) {
    throw new SchemaError(PROVIDER, 'DANX returned a table that is not JSON', { cause: error });
  }
  if (!isRecord(table) || !Array.isArray(table.aaData) || table.aaData.length > MAX_ROWS) return invalid('DANX returned an invalid table');
  return table.aaData.map((row) => (Array.isArray(row) && row.length >= 9 && row.every((cell) => typeof cell === 'string')
    ? row : invalid('DANX returned an invalid row')));
}

const same = (cell: string | undefined, number: string) => normalizeTrackingNumber(cell ?? '') === number;

function clockOf(value: string, pattern: RegExp): string | undefined {
  const parts = pattern.exec(value);
  const date = parts ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!parts || !date || Number(parts[3]) < 2001) return undefined;
  return parts[4] ? `${date}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}` : date;
}

interface Shipment { events: (CarrierEvent & { local_time: string })[]; code: string; destination: string | null; pickup: string }

/** One table row: its scans, newest first, the status code it heads with and where it goes. */
function shipmentOf(row: string[]): Shipment {
  const fields = new Map([...row[7]!.matchAll(FIELD)].map((match) => [textFromHtml(match[1], 40), match[2]!]));
  const status = fields.get('Status');
  if (status === undefined) return invalid('DANX returned a shipment without its scans');
  const blocks = status.split(BLOCK).filter((block) => textFromHtml(block, 10));
  if (blocks.length > MAX_SCANS) return invalid('DANX returned too many scans');
  const seen = new Set<string>();
  const events = blocks.map((block, index) => {
    const [code, clock, ...rest] = block.split(LINE).map((line) => textFromHtml(line, 120));
    if (!code || !CODE.test(code)) return invalid('DANX returned an invalid scan code');
    const localTime = clockOf(clock ?? '', CLOCK) ?? invalid('DANX returned an invalid scan time');
    // A delivery names whoever signed for it; another scan names its terminal.
    const terminal = code.startsWith('POD') ? undefined : rest.find((line) => TERMINAL.test(line));
    const stage = danxCodeStage(code);
    const event: CarrierEvent & { local_time: string } = { local_time: localTime, description: danxStatusText(code) ?? code,
      provider_code: code, ...(terminal ? { location: terminal } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  const code = textFromHtml(row[8], 20);
  if (code && !CODE.test(code)) return invalid('DANX returned an invalid status');
  const address = (fields.get('Delivery Address') ?? '').split(LINE).map((line) => textFromHtml(line, 80)).filter(Boolean);
  const pickup = row[3] ? clockOf(textFromHtml(row[3], 20), DAY) ?? invalid('DANX returned an invalid pickup date') : '';
  return { events, code, destination: countryCode(address.at(-1)), pickup };
}

const newest = (shipment: Shipment) => shipment.events[0]?.local_time ?? shipment.pickup;

/**
 * Reads the table for one number. Names, addresses, the signer, the weight and notes stay
 * behind; the scans keep their wall clock, as the reply gives no zone.
 */
export function parseDanx(payload: unknown, number: string): CarrierResult {
  const rows = danxRows(payload).filter((row) => same(row[2], number) || same(row[1], number));
  if (rows.length === 0) throw new IndeterminateError(PROVIDER, 'DANX answered for another shipment');
  // A label is used again for later shipments, and the tracker lists them all: the newest is the parcel on its way.
  // A reference shared by shipments of different labels names none of them.
  const labelled = rows.filter((row) => same(row[2], number));
  if (labelled.length === 0 && new Set(rows.map((row) => normalizeTrackingNumber(row[2]!))).size > 1) {
    throw new IndeterminateError(PROVIDER, 'DANX lists several shipments under this reference');
  }
  const shipment = (labelled.length ? labelled : rows).map(shipmentOf)
    .reduce((latest, candidate) => (newest(candidate) > newest(latest) ? candidate : latest));

  const { events, code, destination } = shipment;
  const coded = code ? danxCodeStage(code) : undefined;
  const staged = events.find((event) => event.stage);
  const stage = (coded ?? staged?.stage) as Stage | undefined;
  if (events.length === 0 && !coded) return invalid('DANX returned a shipment without a status or scans');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: (code && danxStatusText(code)) || events[0]?.description || null,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
