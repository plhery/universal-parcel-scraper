import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correosEcuadorStage, statusMap, withoutReceiver } from './status.js';

export const PROVIDER = 'Servicios Postales del Ecuador';
export const CORREOS_ECUADOR_ORIGIN = 'https://sipostal.serviciopostal.gob.ec';
/** The tracking page, an ASP.NET form that posts the codes back to itself. */
export const CORREOS_ECUADOR_TRACKING = `${CORREOS_ECUADOR_ORIGIN}/Navegacion/Tracking`;
// The form is about 21 kB and an answer about 22 kB, most of it the site's chrome; a scan adds under 1 kB.
export const CORREOS_ECUADOR_MAX_BYTES = 1024 * 1024;

const MAX_SCANS = 300;
const FORM = {
  number: 'ctl00$MainContent$txt_codigo_envio',
  search: 'ctl00$MainContent$btn_buscar',
  // The reCAPTCHA widget's field, which the page sends empty until its box is ticked.
  captcha: 'g-recaptcha-response',
} as const;
// The form's hidden fields: ASP.NET's state and the page's own.
const HIDDEN = /^(?:__[A-Z]{1,30}|ctl00\$MainContent\$[A-Za-z_]{1,40})$/;
const MAX_FIELD_LENGTH = 100_000;
const NOT_FOUND = /^Código de rastreo no localizado\b/;
const HISTORY = /^Historial de eventos: ([A-Za-z0-9]{1,40})$/;
// What the page says, in a startup script, to a search without a code.
const MESSAGE = /\bmensaje\('[a-z]{1,20}',\s*'[^'\\]{0,80}',\s*'([^'\\]{0,300})'/;
const NO_CODE = /^Ingrese al menos un código/i;
// "Ago. 31, 2022" and "8:59": the day, with Spanish month abbreviations, and the wall clock.
/** A scan's day, written "Sep. 9, 2024" or "09/Sep/2024". */
const DAY = /^(?:([A-Za-z]{3,4})\.? (\d{1,2}), (\d{4})|(\d{1,2})\/([A-Za-z]{3,4})\.?\/(\d{4}))$/;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MONTHS: Readonly<Record<string, number>> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};
// A scan the sending post reports names its country in ISO's style, "United States of America (the)".
const THE = /\s*\(the\)$/i;
// Ecuador's office of exchange receiving an item from abroad.
const INWARD = /^Recibido Ecuador\b/i;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|hcaptcha/i;
// The site's error page, which it shows for a failure or a missing route.
const ERROR_PAGE = /<title>\s*Oops\s*<\/title>/i;

/**
 * The tracker takes UPU S10 item codes, as its example shows: Servicios
 * Postales del Ecuador's own and those of the posts that send mail to Ecuador.
 * The check digit must hold.
 */
export function normalizeCorreosEcuadorNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Servicios Postales del Ecuador tracks S10 item codes');
}

/** Whether a page is a block page instead of the tracker's own. */
export function isCorreosEcuadorBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** A page without what the tracker's has: a block page, the site's error page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isCorreosEcuadorBlocked(html)) throw new ChallengeError(PROVIDER, 'Servicios Postales del Ecuador answered with a block page');
  if (ERROR_PAGE.test(html.slice(0, 64_000))) throw new TransportError(PROVIDER, 'Servicios Postales del Ecuador\'s tracker failed with its error page');
  throw new SchemaError(PROVIDER, message);
}

/** What the form posts to look a code up, as its Consultar button does, with the reCAPTCHA left unticked. */
export function correosEcuadorFormFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form#ctl01');
  if (form.length !== 1 || form.find(`textarea[name="${FORM.number}"]`).length !== 1
    || !form.find('a#MainContent_btn_buscar').attr('href')?.includes(FORM.search)) {
    unexpected(html, 'Servicios Postales del Ecuador returned a tracking page without its form');
  }
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (HIDDEN.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned a tracking page without its state');
  }
  fields.set('__EVENTTARGET', FORM.search);
  fields.set('__EVENTARGUMENT', '');
  fields.set(FORM.number, number);
  fields.set(FORM.captcha, '');
  return fields;
}

/** A node's own text and that of its child span, which the page uses for a scan's clock and place. */
function split(node: Cheerio<AnyNode>, length: number): [string, string] {
  const copy = node.clone();
  const spans = copy.children('span');
  const inner = clean(spans.text(), length);
  spans.remove();
  return [clean(copy.text(), length), inner];
}

/** A scan's wall clock, calendar-checked, on the 24-hour clock the page uses. */
function wallClock(dayText: string, clockText: string): string {
  const day = DAY.exec(dayText);
  const clock = CLOCK.exec(clockText);
  const [monthName, dayOfMonth, year] = day ? [day[1] ?? day[5], day[2] ?? day[4], day[3] ?? day[6]] : [];
  const month = monthName ? MONTHS[monthName.toLowerCase()] : undefined;
  const date = month ? calendarDay(Number(year), month, Number(dayOfMonth)) : null;
  if (!date || !clock) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned an invalid scan time');
  return `${date}T${clock[1]!.padStart(2, '0')}:${clock[2]}:00`;
}

function scanOf(item: Cheerio<AnyNode>): CarrierEvent {
  const [dayText, clockText] = split(item.children('.tracking-date'), 40);
  const [wording, place] = split(item.children('.tracking-content'), 300);
  // A delivery names who took the item, with their cédula; neither is kept.
  const description = clean(withoutReceiver(wording), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned a scan without wording');
  const location = clean(place.replace(THE, ''), 120);
  const staged = correosEcuadorStage(description);
  return {
    local_time: wallClock(dayText, clockText),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The form sent back without an answer: a search without the code, else the reCAPTCHA it holds refused. */
function withoutAnswer($: CheerioAPI, html: string): never {
  const message = $('script').map((_, node) => MESSAGE.exec($(node).text())?.[1]).get().map((text) => clean(text, 200)).find(Boolean) ?? '';
  if (NO_CODE.test(message)) throw new IndeterminateError(PROVIDER, 'Servicios Postales del Ecuador searched without the code');
  if ($(`textarea[name="${FORM.number}"]`).length === 1 && $('.g-recaptcha').length) {
    throw new ChallengeError(PROVIDER, `Servicios Postales del Ecuador sent its reCAPTCHA form back without an answer${message ? `: ${message}` : ''}`);
  }
  unexpected(html, 'Servicios Postales del Ecuador returned its form without an answer');
}

/**
 * The page the tracker answers a posted code with: a card for the code,
 * which repeats it, and the code's history, headed with it, newest first. A
 * scan has a day and a wall clock, its wording and the office or country
 * where it was made. A code it holds nothing for gets a card saying the code
 * was not found. The card's own summary repeats the newest scan, and its note
 * about the Sí Postal fee is the same for every item, so neither is read; a
 * delivery's receiver and their cédula are dropped.
 */
export function parseCorreosEcuador(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCorreosEcuadorNumber(rawNumber);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned an empty page');
  const $ = load(html);
  const panel = $('form#ctl01 #MainContent_udp1');
  if (panel.length !== 1) unexpected(html, 'Servicios Postales del Ecuador returned an unexpected page');
  const labels = panel.find('#MainContent_divEnvios span[id^="MainContent_rpt_envios_lbl_Etiqueta_"]');
  if (!labels.length) withoutAnswer($, html);
  if (labels.length !== 1) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador answered for several codes');
  if (normalizeTrackingNumber(clean(labels.text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Servicios Postales del Ecuador answered for another code');
  }
  const found = panel.find('#MainContent_rpt_envios_divDetalle_0');
  const missing = panel.find('#MainContent_rpt_envios_divDetalleNoExiste_0');
  const history = panel.find('#MainContent_divHistorialEventos');
  if (missing.length) {
    if (missing.length === 1 && !found.length && !history.length && NOT_FOUND.test(clean(missing.text(), 200))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned an unexpected notice');
  }
  if (found.length !== 1 || history.length !== 1) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned the item without its history');
  const heading = HISTORY.exec(clean(history.find('h6').first().text(), 80))?.[1];
  if (!heading) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned an unexpected history heading');
  if (normalizeTrackingNumber(heading) !== number) throw new IndeterminateError(PROVIDER, 'Servicios Postales del Ecuador answered for another code');
  const items = history.find('div.tracking-item');
  if (!items.length) throw new NoHistoryError(PROVIDER);
  if (items.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Servicios Postales del Ecuador returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const item of items.toArray()) {
    const event = scanOf($(item));
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  // An item Ecuador's office of exchange received from abroad is delivered in Ecuador.
  const inward = events.some((event) => INWARD.test(event.description!));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(inward ? { destination_country: 'EC' } : {}),
    events,
  };
}
