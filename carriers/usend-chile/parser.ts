import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { usendStage } from './status.js';

export const PROVIDER = 'USEND';
// A delivered guide's page, with its pieces, photos and map, is about 120 kilobytes.
export const USEND_MAX_BYTES = 1024 * 1024;
// Guides and the codes the tracker is offered: letters and digits, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
// A guide, "WB" and its serial: the number the page's not-found notice speaks for.
const GUIDE = /^WB\d{6,12}$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|g-recaptcha|h-captcha/i;
// The day over a group of movements, "Tuesday, 18 de June del 2024": English names whatever the language asked.
const DAY = /^(?:[a-záéíóúñ]+,\s*)?(\d{1,2})\s+de\s+([a-zé]+)\s+del?\s+(\d{4})$/i;
const CLOCK = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i;
const MONTHS: ReadonlyMap<string, number> = new Map([
  ...['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
    .map((name, index) => [name, index + 1] as const),
  ...['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
    .map((name, index) => [name, index + 1] as const),
  ['setiembre', 9],
]);
/**
 * Movements of the signed delivery receipt (the "cargo") on its way back to the
 * origin agency and the shipper after the delivery: not the parcel's.
 */
const RECEIPT = new Set(['cargo enviado a origen', 'cargo llego a origen', 'se retornado el cargo']);
// Where a movement happened, as its detail line names the agency: "Agencia: CONCEPCION",
// "En Agencia:SANTIAGO", "Arribó en Agencia (SANTIAGO)", or a dispatch's "Desde: SANTIAGO --> Hacia: CONCEPCION".
const PLACES = [
  /^(?:en\s+)?agencia\s*:\s*([^:()]+)$/i,
  /^arrib[oó]\s+en\s+agencia\s*\(([^()]+)\)$/i,
  /^desde\s*:\s*(.+?)\s*(?:-->|->)?\s*hacia\s*:/i,
];
const MAX_ITEMS = 400;
const MAX_EVENTS = 100;

/** A number for USEND's tracker, in upper case as the tracker reads it; anything else is not one USEND issues. */
export function normalizeUsendNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'USEND numbers are six to twenty letters and digits');
  return number;
}

function wordingKey(value: string): string {
  return value.toLocaleLowerCase('es').trim().split(/\s+/).join(' ');
}

/** The calendar day over a group of movements, or null for text that is not one. */
function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  const month = match ? MONTHS.get(match[2]!.toLowerCase()) : undefined;
  return match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
}

/** A movement's clock, "10:07 pm", on its day: the agency's wall clock, to the minute. */
function wallClock(day: string, value: string): string {
  const match = CLOCK.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour < 1 || hour > 12 || minute > 59) throw new SchemaError(PROVIDER, 'USEND returned an invalid movement time');
  const hours = (hour % 12) + (match[3]!.toLowerCase() === 'p' ? 12 : 0);
  return `${day}T${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

/** The agency a movement's detail line names, or nothing. Signatories, vehicles and creation notes name none. */
function placeOf(detail: string): string | undefined {
  for (const pattern of PLACES) {
    const name = pattern.exec(detail)?.[1]?.trim();
    if (name && /^[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ .'-]{0,59}$/.test(name)) return name;
  }
  return undefined;
}

/** The text of the page's own notices and headings, whitespace collapsed. */
function textOf($: CheerioAPI, selector: Parameters<CheerioAPI>[0]): string {
  return clean($(selector).first().text(), 200);
}

/**
 * The movements of the guide's "Historial", newest first as the page lists them.
 * Each day is a `period` item over its movements; a movement gives its clock,
 * its wording and a detail line. Only the agency is kept from the detail: it
 * also names the vehicle, the person who signed with their ID number and the
 * staff who created the guide. The pieces' own timelines repeat the guide's.
 */
function history($: CheerioAPI): CarrierEvent[] {
  const card = $('h6.card-title').filter((_, heading) => clean($(heading).text(), 40).toLowerCase() === 'historial').first().closest('.card');
  const lists = card.find('ul.timeline');
  if (!card.length || lists.length !== 1) throw new SchemaError(PROVIDER, 'USEND returned a page without its history');
  const items = lists.first().children('li.timeline-item');
  if (items.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'USEND returned an oversized history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let day: string | null = null;
  for (const item of items.toArray()) {
    const node = $(item);
    if (node.hasClass('period')) {
      day = dayOf(clean(node.find('.timeline-title').first().text(), 80));
      if (!day) throw new SchemaError(PROVIDER, 'USEND returned an invalid history day');
      continue;
    }
    const wording = clean(node.find('h3.timeline-title').first().text(), 200);
    if (!wording || RECEIPT.has(wordingKey(wording))) continue;
    if (!day) throw new SchemaError(PROVIDER, 'USEND returned a movement without its day');
    const local = wallClock(day, clean(node.find('.timeline-info span').first().text(), 20));
    const location = placeOf(clean(node.find('.timeline-content > p').first().text(), 300));
    const key = JSON.stringify([local, wording, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = usendStage(wording);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description: wording,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/**
 * The guest tracker's page for a guide, `portal.usend.cl/rastrear-shipper/{guide}`.
 * Its heading names the guide it shows. For a guide it does not hold it answers
 * HTTP 200 with an empty heading and a notice that the guide "no existe"; it
 * answers the same for the shipment's other codes it does not look up by, so
 * the notice settles only a guide.
 */
export function parseUsend(html: string, raw: string): CarrierResult {
  const number = normalizeUsendNumber(raw);
  const $ = load(html);
  const shown = normalizeTrackingNumber(textOf($, '#basic-layout-form strong'));
  if (!shown) {
    const notice = $('.alert.alert-danger').filter((_, alert) => /no existe/i.test($(alert).text())).first();
    if (notice.length) {
      const asked = normalizeTrackingNumber(clean(notice.find('strong').first().text(), 64));
      if (asked !== number) throw new IndeterminateError(PROVIDER, 'USEND answered for another number');
      if (GUIDE.test(number)) throw new NotFoundError(PROVIDER, 'USEND has no guide under the number');
      throw new IndeterminateError(PROVIDER, 'USEND\'s tracker shows nothing for the number', { reason: 'portal_not_found' });
    }
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'USEND answered with a browser check');
    throw new SchemaError(PROVIDER, 'USEND returned a page without a guide');
  }
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'USEND answered for another shipment');
  const events = history($);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'USEND lists the guide without movements', { reason: 'listed' });
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
