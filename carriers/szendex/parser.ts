import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { szendexStage } from './status.js';

export const PROVIDER = 'Szendex';
/** The zone of Szendex's network, peninsular Spain, which writes every clock the tracker shows. */
export const SZENDEX_ZONE = 'Europe/Madrid';
// A shipment's page is about 20 kB, most of it its view state.
export const SZENDEX_MAX_BYTES = 512 * 1024;

// The tracker's field takes up to 30 characters, and the form on szendex.com asks for six or more.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const NOT_FOUND = /^No se ha encontrado el env\S{1,2}o solicitado\.?$/i;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
// "27/01/2023    8:38": a day and a wall clock to the minute, with no zone.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MAX_ROWS = 300;

/** A number for Szendex's tracker: a shipment or service order number. */
export function normalizeSzendexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Szendex numbers are 6 to 30 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Upper case without accents, to compare the page's labels. */
const fold = (value: string) => clean(value, 200).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

/** The text of the one element with an id, or undefined when the page has none. */
function byId($: CheerioAPI, id: string): string | undefined {
  const found = $(`[id="${id}"]`);
  if (found.length > 1) return invalid(`Szendex returned a page with ${id} twice`);
  return found.length ? clean(found.text(), 300) : undefined;
}

/** Whether the page's form posts back to the number asked, as the tracker's page for it does. */
function postsBack($: CheerioAPI, number: string): boolean {
  const action = $('form#form1').attr('action') ?? '';
  const seg = /[?&]seg=([^&#]*)/i.exec(action)?.[1];
  if (seg === undefined) return false;
  try {
    return normalizeTrackingNumber(decodeURIComponent(seg.replace(/\+/g, ' '))) === number;
  } catch {
    return false;
  }
}

/** A day and wall clock as the grid and summary write them; the page names no zone. */
function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const date = parts ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!parts || !date || Number(parts[4]) > 23 || Number(parts[5]) > 59) return invalid('Szendex returned an invalid time');
  return `${date}T${parts[4]!.padStart(2, '0')}:${parts[5]}:00`;
}

type Scan = CarrierEvent & { local_time: string; time: string; description: string };

/**
 * A wall clock dated on Madrid's clock, the zone of the network: the page
 * gives no place for a scan to settle another one by.
 */
function dated(local: string): Pick<Scan, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = isoTime(local, SZENDEX_ZONE)?.iso ?? invalid('Szendex returned an invalid time');
  return { local_time: local, time, time_zone: SZENDEX_ZONE, time_zone_basis: 'carrier' };
}

/** The history grid, headed Fecha, Estado and Descripción, oldest first. Descripción is not read. */
function scansOf($: CheerioAPI): Scan[] {
  const grids = $('table#gvTrazabilidad');
  if (grids.length > 1) return invalid('Szendex returned more than one history');
  if (!grids.length) return [];
  const rows = grids.first().find('tr').toArray();
  const header = $(rows[0]).children('th').toArray().map((cell) => fold($(cell).text())).join('|');
  if (header !== 'FECHA|ESTADO|DESCRIPCION') return invalid('Szendex returned a changed history');
  if (rows.length > MAX_ROWS) return invalid('Szendex returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows.slice(1)) {
    const cells = $(row).children('td');
    if (cells.length !== 3) return invalid('Szendex returned a changed history row');
    const local = wallClock(clean(cells.eq(0).text(), 40));
    const description = clean(cells.eq(1).text(), 120) || invalid('Szendex returned a scan without its state');
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = szendexStage(description);
    scans.push({ ...dated(local), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Newest first; scans of one minute keep the page's order, turned round.
  return scans.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
}

/** The summary's date row: the delivery, the expected delivery day or a service order's pickup. */
function summaryDate($: CheerioAPI): { label: string; value: string } {
  return { label: fold(byId($, 'lblFechaEntregaRes') ?? '').replace(/:$/, ''), value: byId($, 'lblFechaEntregaDataRes') ?? '' };
}

/**
 * The tracker's page for one number, as HTML: a summary with the number and
 * its state, a grid of the states it went through, and the shipment's
 * details. A service order, the pickup that packages leave under numbers of
 * their own, has the same page with the pickup's states. The recipient, the
 * towns, the reference, the remarks, the agency's phone, the pickup's map link
 * and the delivery note image are not read, nor the view state, which holds
 * the address and the sender.
 */
export function parseSzendex(html: string, raw: string): CarrierResult {
  const number = normalizeSzendexNumber(raw);
  const $ = load(html);
  const error = byId($, 'lblStackTrace');
  const shown = byId($, 'lblNumSeguimientoDataRes');
  if (error !== undefined) {
    if (shown !== undefined) return invalid('Szendex returned an error beside a shipment');
    // The notice names no number; the page's form posts back to the one it looked up.
    if (NOT_FOUND.test(error) && postsBack($, number)) throw new NotFoundError(PROVIDER);
    if (NOT_FOUND.test(error)) throw new IndeterminateError(PROVIDER, 'Szendex answered for another number');
    throw new IndeterminateError(PROVIDER, 'Szendex answered with an error');
  }
  // A reference several shipments carry lists them to choose from.
  if ($('[id="gvSeleccionEnvio"]').length) throw new IndeterminateError(PROVIDER, 'Szendex lists several shipments under this reference');
  if (shown === undefined) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Szendex answered with a browser check');
    return invalid('Szendex did not return its tracking page');
  }
  // The tracker also finds a shipment by its sender's reference, and names it by its own number.
  const details = byId($, 'lblNumSeguimientoData');
  if (normalizeTrackingNumber(shown) !== number || (details !== undefined && normalizeTrackingNumber(details) !== number)) {
    throw new IndeterminateError(PROVIDER, 'Szendex answered for another number');
  }

  const events = scansOf($);
  const state = byId($, 'lblEstadoDataRes') ?? '';
  const summary: ClassifiedWording | null = state ? szendexStage(state) : null;
  const scanned = events.find((event) => event.stage);
  // The summary's state is the current one; a state it words in a way no rule reads leaves the newest staged scan.
  const current = summary ?? (scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null);
  const newest = events[0];
  if (!newest && !state) throw new NoHistoryError(PROVIDER);

  const date = summaryDate($);
  const day = DAY.exec(date.value);
  const expected = date.label === 'FECHA PREVISTA DE ENTREGA' && day ? calendarDay(Number(day[3]), Number(day[2]), Number(day[1])) : null;
  const delivered = current?.stage === 'delivered'
    ? (date.label === 'FECHA DE ENTREGA' && CLOCK.test(date.value) ? dated(wallClock(date.value)).time : events.find((event) => event.stage === 'delivered')?.time)
    : undefined;
  const service = byId($, 'lblTipoServicioData') ?? '';
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: state || newest!.description,
    last_update: newest?.time ?? null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: current?.stage === 'delivered' ? null : expected,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
