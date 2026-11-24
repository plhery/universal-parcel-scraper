import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { ENTRY, inposdomStage } from './status.js';

export const PROVIDER = 'INPOSDOM';
export const INPOSDOM_ORIGIN = 'https://inposdomtech.com';
/** The tracker's page, Inposoft's customer service, which holds the search form. */
export const INPOSDOM_FORM = `${INPOSDOM_ORIGIN}/Inposoft/cliente/`;
/** Where the form posts the number. */
export const INPOSDOM_SEARCH = `${INPOSDOM_ORIGIN}/Inposoft/cliente/index.php`;
// The page is about 6 kB with one record; each record adds about 250 bytes.
export const INPOSDOM_MAX_BYTES = 256 * 1024;

const MAX_ROWS = 50;
// The result table's columns, as the page heads them.
const COLUMNS = ['Servicio', 'Código de Envío', 'Peso', 'Oficina de Destino', 'Destinatario', 'Monitor', 'Fecha de Entrada', 'Estatus', 'Direccion'];
const column = (head: string) => COLUMNS.indexOf(head);
const SERVICE = column('Servicio');
const CODE = column('Código de Envío');
const OFFICE = column('Oficina de Destino');
const ENTERED = column('Fecha de Entrada');
const STATUS = column('Estatus');
const ADDRESS = column('Direccion');
const FOUND = /^HEMOS ENCONTRADO (\d{1,3}) REGISTRO\(S\)$/;
const NOT_FOUND = /^TU CODIGO DE ENVIO NO ES CORRECTO O NO HA INGRESADO A REPÚBLICA DOMINICANA\.?$/;
// What the page says to a search for nothing.
const NO_TERM = /Búsqueda sin resultados/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha/i;

/** The tracker reads UPU S10 item codes, as its page explains; the check digit must hold. */
export function normalizeInposdomNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'INPOSDOM tracks S10 item codes');
}

/** Whether a page is a block page instead of the tracker's own. */
export function isInposdomBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isInposdomBlocked(html)) throw new ChallengeError(PROVIDER, 'INPOSDOM answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** The entry date, a day without a clock; a zero date or none is no date. */
function dayOf(text: string): string | undefined {
  if (!text || text === '0000-00-00') return undefined;
  if (!DAY.test(text) || !DateTime.fromISO(text, { zone: 'utc' }).isValid) {
    throw new SchemaError(PROVIDER, 'INPOSDOM returned an invalid entry date');
  }
  return text;
}

/**
 * The page INPOSDOM's tracker, Inposoft's customer service, answers a posted
 * number with. It searches the items that have entered the Dominican
 * Republic, by any part of their code, and lists the records found in a table:
 * the service, the code, the weight, the destination office, the addressee, a
 * monitor, the entry date, the status and the destination office's address.
 * A record holds one status, not a history. A search that finds nothing gets
 * a warning that the code is wrong or has not entered the country, which does
 * not repeat the code: the request that posted it binds the answer to it.
 * The weight has no unit, and the addressee and the monitor are not read.
 */
export function parseInposdom(html: string, rawNumber: string): CarrierResult {
  const number = normalizeInposdomNumber(rawNumber);
  const $ = load(html);
  if ($('form#buscador input[name="buscar"]').length !== 1) unexpected(html, 'INPOSDOM returned an unexpected page');
  const found = $('div.alert-success');
  const rows = $('table tbody > tr');
  if (!found.length) {
    const warning = $('div.alert-warning');
    if (warning.length === 1 && !rows.length && NOT_FOUND.test(clean(warning.find('strong').text(), 200))) throw new NotFoundError(PROVIDER);
    if (NO_TERM.test(clean($('body').text(), 8000))) throw new IndeterminateError(PROVIDER, 'INPOSDOM searched without the number');
    unexpected(html, 'INPOSDOM returned its form without an answer');
  }
  const count = FOUND.exec(clean(found.find('strong').text(), 80));
  const tables = $('table');
  if (found.length !== 1 || !count || tables.length !== 1) throw new SchemaError(PROVIDER, 'INPOSDOM returned an invalid result');
  const heads = tables.find('thead th').toArray().map((head) => clean($(head).text(), 40));
  if (heads.join('|') !== COLUMNS.join('|')) throw new SchemaError(PROVIDER, 'INPOSDOM changed its result table');
  if (rows.length !== Number(count[1]) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'INPOSDOM returned an invalid result');
  const records = rows.toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'INPOSDOM returned an invalid record');
    return (index: number, length = 120) => clean(cells.eq(index).text(), length);
  });
  // The search finds codes that hold the number asked; only the whole code is the item.
  const own = records.filter((cell) => normalizeTrackingNumber(cell(CODE, 64)) === number);
  if (!own.length) throw new IndeterminateError(PROVIDER, 'INPOSDOM answered for other items');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'INPOSDOM listed several records for the item');
  const cell = own[0]!;

  const day = dayOf(cell(ENTERED, 20));
  const wording = cell(STATUS);
  if (!day && !wording) throw new NoHistoryError(PROVIDER);
  // The day the item entered the Dominican Republic: the record's only date.
  const events: CarrierEvent[] = day ? [{ local_time: day, description: ENTRY, stage: 'in_transit', stage_source: 'carrier_map' }] : [];
  // The status has no date of its own; without a stage the entry's stands.
  const staged: ClassifiedWording | null = (wording ? inposdomStage(wording) : null)
    ?? (day ? { stage: 'in_transit', source: 'carrier_map' } : null);
  const office = cell(OFFICE, 80);
  const address = cell(ADDRESS, 200);
  const service = cell(SERVICE, 80);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: wording || ENTRY,
    last_update: null,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    destination_country: 'DO',
    // The destination office is where the item waits once its status says it is ready for collection.
    ...(staged?.stage === 'ready_for_pickup' && office ? { pickup_point: [office, address].filter(Boolean).join('\n') } : {}),
    // The record gives the current status and the entry date, not the item's scans.
    summary_only: true,
    events,
  };
}
