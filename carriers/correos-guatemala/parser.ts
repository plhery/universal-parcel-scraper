import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correosGuatemalaCodeStage, correosGuatemalaWordingStage } from './status.js';

export const PROVIDER = 'Correos de Guatemala';
/** The tracker the post's site links to, which answers plain HTTP on a bare address; its form posts here. */
export const CORREOS_GUATEMALA_PAGE = 'http://181.119.103.67/index.php';

const MAX_ROWS = 300;
const NOT_FOUND = /^No se encontr[oó] informaci[oó]n relacionada al Tracking$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// The full history the page carries in an HTML comment after its steps.
const FULL_HISTORY = /<!--\s*<h2>Historial Completo:<\/h2>([\s\S]{0,400000}?)-->/;
const HEADINGS = ['Código', 'Fecha', 'Descripción', 'Ubicación', 'Tipo', 'Fuente'];
// "2026-10-30 14:37:00.000": the office's wall clock, to the millisecond.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?$/;
// "30/10/2026": a step's day.
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** The tracker's form takes UPU S10 item codes, Guatemala's own and those sent to Guatemala. */
export function normalizeCorreosGuatemalaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Correos de Guatemala tracks postal item codes such as EE123456789GT');
  return number;
}

function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Correos de Guatemala returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

function staged(stage: Stage | undefined): Pick<CarrierEvent, 'stage' | 'stage_source'> {
  return stage ? { stage, stage_source: 'carrier_map' } : {};
}

/**
 * The office scans of the full history, oldest first: code, clock, wording, office, type and
 * source, then the next office when the table has that column. Null when the page does not
 * carry the history or carries it in another shape: its steps stand instead.
 */
function officeScans(html: string): CarrierEvent[] | null {
  const comment = FULL_HISTORY.exec(html)?.[1];
  const start = comment ? comment.indexOf('<thead') : -1;
  if (start < 0) return null;
  const $ = load(`<table>${comment!.slice(start)}`);
  const headings = $('thead th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (JSON.stringify(headings.slice(0, HEADINGS.length)) !== JSON.stringify(HEADINGS) || headings.length > HEADINGS.length + 1) return null;
  const rows = $('tbody > tr').toArray();
  if (!rows.length || rows.length > MAX_ROWS) return null;
  const scans: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td').map((_, cell) => clean($(cell).text(), 200)).get();
    const [code, clock, description, office] = cells;
    if (cells.length !== headings.length || !/^\d{1,6}$/.test(code!) || !CLOCK.test(clock!) || !description) return null;
    scans.push({ local_time: wallClock(clock!), description, provider_code: code!, ...(office ? { location: office } : {}),
      ...staged(correosGuatemalaCodeStage(code!)) });
  }
  return scans;
}

/** The steps the page shows, oldest first, each dated by its day alone. */
function pageSteps($: CheerioAPI): CarrierEvent[] {
  const items = $('#historialEventos .timeline-item').toArray();
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correos de Guatemala returned an oversized history');
  return items.map((item) => {
    const date = DAY.exec(clean($(item).find('h6').text(), 40).replace(/^Fecha:\s*/, ''));
    const day = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
    const description = clean($(item).find('p').text(), 200);
    if (!day || !description) throw new SchemaError(PROVIDER, 'Correos de Guatemala returned an invalid step');
    return { local_time: day, description, ...staged(correosGuatemalaWordingStage(description)) };
  });
}

/**
 * The tracker's answer to its form: the item, its origin and destination countries and a status
 * line, then the steps it shows by day. The same page carries, in an HTML comment, the full
 * history of office scans with their clocks, which is read when present. An item the tracker
 * holds nothing for gets its notice instead, which is not found.
 */
export function parseCorreosGuatemala(html: string, raw: string): CarrierResult {
  const number = normalizeCorreosGuatemalaNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Correos de Guatemala returned an empty page');
  const $ = load(html);
  const results = $('#resultados-rastreo');
  if ($('title').text().trim() !== 'Rastreo de Paquetes' || results.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correos de Guatemala answered with a block page');
    throw new SchemaError(PROVIDER, 'Correos de Guatemala returned a page without its tracking results');
  }
  const summary = results.find('table').first().find('tbody > tr');
  if (!summary.length) {
    if (NOT_FOUND.test(clean(results.find('.alert-danger').text(), 120))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Correos de Guatemala returned a page without the item');
  }
  const cells = summary.first().children('td').map((_, cell) => clean($(cell).text(), 80)).get();
  if (summary.length !== 1 || cells.length !== 3) throw new SchemaError(PROVIDER, 'Correos de Guatemala returned an unexpected summary');
  const [item, , destination] = cells;
  if (item!.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Correos de Guatemala answered for another item');
  const line = clean(results.find('.alert').first().text(), 200);
  const scans = officeScans(html) ?? pageSteps($);
  const seen = new Set<string>();
  const events = scans.filter((event) => {
    // A scan the page lists twice is kept once.
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The status line is the page's own reading of the item, a return included, which the
  // scans alone leave as a dispatch abroad; else the newest scan with a stage.
  const stage = (line ? correosGuatemalaWordingStage(line) : undefined) ?? events.find((event) => event.stage)?.stage as Stage | undefined;
  // The destination is that of the newest dispatch: on a return it names the country the item
  // goes back to, which is not the shipment's. IPS names some countries in ISO's style,
  // "United States of America (the)".
  const country = destination && stage !== 'returned' ? countryCode(destination.replace(/\s*\(the\)$/i, '')) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: line || events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
