import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap, urbanoStage } from './status.js';

export const PROVIDER = 'Urbano Argentina';
/** The page the tracking form opens for a shipper's code and the shipment's code under it. */
export const URBANO_LOOKUP = 'https://apis.urbano.com.ar/cespecifica/';
/** Where that page's magnifier posts a row to read its scans. */
export const URBANO_DETAIL = 'https://apis.urbano.com.ar/cespecifica/class/especifica_controller.php';
// Both pages are under 10 kB.
export const URBANO_MAX_BYTES = 256 * 1024;
/** The page lists one row per product; more than this many is not one shipment. */
export const URBANO_MAX_ROWS = 3;

// The tracking form's split: Mercado Libre's codes start with DVPQ0101 and belong to shipper 2273;
// other numbers start with the shipper's four digits, and the rest is the shipment's code.
const MERCADO_LIBRE = /^DVPQ0101([A-Z0-9]{1,24})$/;
const SHIPPER_FIRST = /^(\d{4})([A-Z0-9]{1,24})$/;
const MERCADO_LIBRE_SHIPPER = '2273';
// "09-05-2023" and "15:49": a scan's day and wall clock.
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// "DL - Su envio fue entregado": a scan's code and wording.
const CODED = /^([A-Z]{2})\s*-\s*(\S.*)$/;
// "1-PARANA", "B- UEA -C.T.P.": the branch's number or letter before its name.
const BRANCH = /^[0-9A-Z]{1,3}\s*-\s*/;
// A firewall's or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|requested URL was rejected/i;

export interface UrbanoNumber {
  /** The number as asked, normalized. */
  number: string;
  /** The shipper's code as the page takes it: six digits. */
  shipper: string;
  /** The shipment's code under that shipper. */
  code: string;
}

/** A row of the lookup page: its data, posted back as is to read its scans, and the fields the parser reads. */
export interface UrbanoRow {
  data: string;
  product: string;
  shipper: string;
  code: string;
  listed: boolean;
}

/** An Urbano number split the way its tracking form splits it. */
export function normalizeUrbanoNumber(raw: string): UrbanoNumber {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  const mercadoLibre = MERCADO_LIBRE.exec(number);
  if (mercadoLibre) return { number, shipper: `00${MERCADO_LIBRE_SHIPPER}`, code: mercadoLibre[1]! };
  const split = SHIPPER_FIRST.exec(number);
  if (!split) throw new InvalidInputError(PROVIDER, 'Urbano numbers start with the shipper\'s four digits, or with DVPQ0101');
  return { number, shipper: `00${split[1]}`, code: split[2]! };
}

/** The lookup page's address for a number. */
export function urbanoLookupUrl({ shipper, code }: UrbanoNumber): string {
  return `${URBANO_LOOKUP}?${new URLSearchParams({ shi_codigo: shipper, cli_codigo: code }).toString()}`;
}

/** Whether a page is a firewall's or a bot check's instead of the tracker's. */
export function isUrbanoBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

const invalid = (message = 'Urbano changed its tracking page'): never => { throw new SchemaError(PROVIDER, message); };

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return invalid('Urbano returned an invalid shipment row');
  return value;
}

/**
 * The rows of the lookup page for a number, after checking that they are this number's. An
 * unknown code gets one row with no client record (`cliId` 0), no product and "Sin información",
 * which is not found; a code the shipper registered without a guide keeps its client record and
 * has no product. The name the page shows, masked, is never read.
 */
export function parseUrbanoLookup(html: string, asked: UrbanoNumber): UrbanoRow[] {
  const $ = load(html);
  if ($('title').first().text().trim() !== 'Seguimiento de pieza') {
    if (isUrbanoBlocked(html)) throw new ChallengeError(PROVIDER, 'Urbano answered with a block page');
    invalid('Urbano did not return its tracking page');
  }
  const rows: UrbanoRow[] = [];
  $('tr[data]').each((_, node) => {
    const data = $(node).attr('data') ?? '';
    let record: unknown;
    try {
      record = JSON.parse(data);
    } catch {
      return invalid('Urbano returned an unreadable shipment row');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return invalid('Urbano returned an invalid shipment row');
    const fields = record as Record<string, unknown>;
    const client = field(fields, 'cliId');
    rows.push({
      data,
      product: field(fields, 'producto').trim(),
      shipper: field(fields, 'shipper').trim(),
      code: field(fields, 'cliCodigo').trim().toUpperCase(),
      listed: /^\d+$/.test(client) && Number(client) > 0,
    });
  });
  if (!rows.length) return invalid('Urbano returned its tracking page without a shipment row');
  if (rows.length > URBANO_MAX_ROWS) throw new IndeterminateError(PROVIDER, 'Urbano listed more rows than one shipment has');
  // The page repeats the shipper and the code it was asked for in each row.
  if (rows.some((row) => row.shipper !== asked.shipper || row.code !== asked.code)) {
    throw new IndeterminateError(PROVIDER, 'Urbano answered for another shipment');
  }
  return rows;
}

/** A scan's wall clock from its day and time, calendar-checked. The page names no zone. */
function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const calendar = date && calendarDay(Number(date[3]), Number(date[2]), Number(date[1]));
  if (!date || !clock || !calendar || Number(date[3]) < 2000) return invalid('Urbano returned an invalid scan time');
  return `${calendar}T${clock[1]}:${clock[2]}:00`;
}

interface Scan { event: CarrierEvent; order: number }

/**
 * The scans the detail page lists for one row, oldest first as it numbers them. The detail also
 * shows the recipient's masked street, town and phone, which are never read.
 */
export function parseUrbanoDetail(html: string): Scan[] {
  const $ = load(html);
  const heading = $('h3').filter((_, node) => clean($(node).text(), 40) === 'Seguimiento de pieza');
  if (heading.length !== 1) {
    if (isUrbanoBlocked(html)) throw new ChallengeError(PROVIDER, 'Urbano answered with a block page');
    invalid('Urbano did not return the shipment\'s scans');
  }
  const table = $('table').last();
  const headers = table.find('thead th').map((_, node) => clean($(node).text(), 20)).get();
  const at = (label: string) => headers.indexOf(label);
  const [number, state, day, time, branch] = [at('N°'), at('Estado'), at('Fecha'), at('Hora'), at('Agencia')];
  if ([state, day, time, branch].some((index) => index < 0)) return invalid('Urbano changed its scan table');
  const scans: Scan[] = [];
  table.find('tbody tr').each((index, node) => {
    const cells = $(node).children('td').map((_, cell) => clean($(cell).text(), 200)).get();
    if (cells.length !== headers.length) return invalid('Urbano returned an incomplete scan');
    const coded = CODED.exec(cells[state]!);
    const code = coded?.[1] ?? null;
    const description = coded ? clean(coded[2], 200) : cells[state]!;
    if (!description) return invalid('Urbano returned a scan without its status');
    const location = cells[branch]!.replace(BRANCH, '').trim();
    const staged = urbanoStage(code, description);
    const order = number >= 0 && /^\d{1,4}$/.test(cells[number]!) ? Number(cells[number]) : index + 1;
    scans.push({ order, event: {
      local_time: wallClock(cells[day]!, cells[time]!),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  return scans;
}

/** Whether a row has a guide whose scans can be read. */
export function hasGuide(row: UrbanoRow): boolean {
  return Boolean(row.product);
}

/**
 * The result for a number from its lookup rows and the scans of each row with a guide. Scans are
 * newest first; those of one minute keep the order the page numbers them in.
 */
export function urbanoResult(rows: readonly UrbanoRow[], details: readonly Scan[][]): CarrierResult {
  if (!rows.some(hasGuide)) {
    if (rows.some((row) => row.listed)) {
      throw new NoHistoryError(PROVIDER, 'Urbano lists the shipment without a guide', { reason: 'listed' });
    }
    throw new NotFoundError(PROVIDER, 'Urbano has no shipment under this number');
  }
  const scans = details.flatMap((detail, index) => detail.map((scan) => ({ ...scan, row: index })));
  const events = scans
    .sort((a, b) => {
      const at = String(a.event.local_time);
      const bt = String(b.event.local_time);
      if (at !== bt) return at < bt ? 1 : -1;
      return a.row === b.row ? b.order - a.order : b.row - a.row;
    })
    .map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Urbano lists the shipment without scans', { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
