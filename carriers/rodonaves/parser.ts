import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { codedStage, HIDDEN_BRUDAM_CODES, rodoCode, statusMap } from './status.js';

export const PROVIDER = 'rodonaves';
/** The road system's lookup, which the tracking page asks first: `?ProtocolNumber=<number>`. */
export const RODO_LOOKUP = 'https://rodonaves.com.br/bin/rodonaves/trackingv3/package';
/** The lookup of Brudam, the system of the Rodo Aéreo services, which the page asks next: `?codigo=<number>&prefixo=minuta`. */
export const BRUDAM_LOOKUP = 'https://rodonaves.com.br/bin/rodonaves/trackingv3/brudam';
export const TRACKER_PAGE = 'https://rodonaves.com.br/rastreio-de-mercadoria';
// A delivered Rodo Aéreo minuta's reply, with its billing records, is about 17 KB.
export const RODONAVES_MAX_BYTES = 1024 * 1024;
/** Brudam's answer for a minuta it does not hold; the tracking page shows "Nenhum pedido encontrado." for it. */
export const BRUDAM_NOT_FOUND = 'Erro na consulta do documento.';

// A protocol or minuta number: the page takes up to twelve digits. Minutas have six.
const NUMBER = /^\d{5,12}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2023-07-20 14:56:00" or "2023-07-20T14:56:00.000": a wall clock without a zone.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
// "EMBARQUE NO VOO (GRU)": the airport an air event happened at, as Brudam appends it.
const AIRPORT = /\(([A-Z]{3})\)\s*$/;
const MAX_EVENTS = 500;

/** A Rodonaves protocol or minuta number: its digits, without the dots, dashes or spaces it is written with. */
export function normalizeRodonavesNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 40 ? normalizeTrackingNumber(raw).replace(/[.\-/]/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Rodonaves tracks protocol and minuta numbers of 5 to 12 digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isRodonavesBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function rodonavesJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isRodonavesBlocked(body)) throw new ChallengeError(PROVIDER, 'Rodonaves answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Rodonaves returned a reply that is not JSON', { cause });
  }
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Two numbers name the same shipment when their digits match, leading zeros aside. */
const sameNumber = (value: unknown, number: string): boolean => (typeof value === 'string' || typeof value === 'number')
  && String(value).trim().replace(/^0+/, '') === number.replace(/^0+/, '');

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`Rodonaves returned an invalid ${what}`);
}

/** A code, as a string of digits, or nothing. */
function codeOf(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const code = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? value.trim() : null;
  return code ?? invalid(`Rodonaves returned an invalid ${what}`);
}

/** An event's clock: a wall clock without a zone stays one, an instant keeps its stated offset. */
function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const raw = typeof value === 'string' ? value.trim() : '';
  const wall = WALL_CLOCK.exec(raw);
  if (wall) {
    const day = calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3]));
    if (!day || Number(wall[1]) < 2000) return invalid('Rodonaves returned an invalid event time');
    return { local_time: `${day}T${wall[4]}:${wall[5]}:${wall[6] ?? '00'}` };
  }
  const instant = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? explicitOffsetTime(raw) : null;
  return instant ? { time: instant.iso } : invalid('Rodonaves returned an event without its time');
}

/** A date for the delivery estimate, from a wall clock, or nothing. */
function dayOf(value: unknown): string | null {
  const wall = typeof value === 'string' ? WALL_CLOCK.exec(value.trim()) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  return wall ? calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3])) : null;
}

/** The result for events listed newest first: the newest event with a stage leads. */
function resultOf(events: CarrierEvent[], facts: Partial<CarrierResult>, expected: string | null): CarrierResult {
  const lead = leadingScan(events, statusMap) ?? events[0]!;
  const stage = lead.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead.stage_source ?? 'carrier_map' } : {}),
    last_status_text: lead.description!,
    last_update: lead.time ?? null,
    ...(lead.local_time ? { last_update_local: lead.local_time } : {}),
    expected_delivery: stage === 'delivered' ? null : expected,
    ...facts,
    events,
  };
}

const newestFirst = (events: CarrierEvent[]): CarrierEvent[] => events
  .map((event, index) => ({ event, index, at: event.local_time ?? event.time ?? '' }))
  .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.index - b.index))
  .map(({ event }) => event);

/**
 * The road system's reply, as the tracking page reads it: the protocol number, the freight
 * document and its events, each with the step id (`HistoricId`) the page groups them by. The
 * sender's and recipient's names are never read.
 */
export function parseRodo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRodonavesNumber(raw);
  if (!isRecord(payload)) return invalid('Rodonaves returned an unexpected road reply');
  if (!sameNumber(payload.ProtocolNumber, number)) throw new IndeterminateError(PROVIDER, 'Rodonaves answered for another shipment');
  if (payload.Events !== null && payload.Events !== undefined && !Array.isArray(payload.Events)) return invalid('Rodonaves returned invalid road events');
  const rows = (payload.Events ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('Rodonaves returned too many events');
  const events = newestFirst(rows.map((row) => {
    if (!isRecord(row)) return invalid('Rodonaves returned an invalid road event');
    const description = text(row.Description, 200, 'road event') || invalid('Rodonaves returned a road event without its wording');
    const code = rodoCode(codeOf(row.HistoricId, 'road step'), codeOf(row.EventCode, 'road event code'), codeOf(row.ProcedaCode, 'road event code'));
    const stage = codedStage(code);
    return {
      ...clockOf(row.Date),
      description,
      ...(code === null ? {} : { provider_code: code }),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } satisfies CarrierEvent;
  }));
  if (!events[0]) throw new NoHistoryError(PROVIDER, 'Rodonaves lists the shipment without events', { reason: 'listed' });
  const emission = dayOf(payload.EmissionDate);
  const days = typeof payload.ExpectedDeliveryDays === 'number' && Number.isSafeInteger(payload.ExpectedDeliveryDays) ? payload.ExpectedDeliveryDays : null;
  // The page's estimate: the newer of the rescheduled date and the emission date plus its working days.
  const scheduled = dayOf(payload.NewDateSchedule);
  const counted = emission && days !== null && days >= 0 && days < 60 ? addWorkingDays(emission, days) : null;
  const expected = [scheduled, counted].filter((day): day is string => day !== null).sort().at(-1) ?? null;
  return resultOf(events, { service_name: 'Rodoviário' }, expected);
}

function addWorkingDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  for (let added = 0; added < count;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

/** What Brudam's reply says about the minuta asked: its record, or its own not-found answer. */
export function brudamRecord(payload: unknown, number: string): Record<string, unknown> | 'not_found' {
  if (!isRecord(payload)) return invalid('Rodonaves returned an unexpected Rodo Aéreo reply');
  // The servlet's own failure, which the page shows as no result, says nothing about the minuta.
  if (payload.success === false) throw new IndeterminateError(PROVIDER, 'Rodonaves did not complete the Rodo Aéreo lookup');
  if (payload.status !== 1 || !Array.isArray(payload.data)) return invalid('Rodonaves returned an unexpected Rodo Aéreo reply');
  if (payload.data.length !== 1 || !isRecord(payload.data[0])) return invalid('Rodonaves returned an unexpected Rodo Aéreo reply');
  const record = payload.data[0];
  if (!sameNumber(record.documento, number)) throw new IndeterminateError(PROVIDER, 'Rodonaves answered for another shipment');
  if (record.status === 0) {
    if (clean(record.message, 100) === BRUDAM_NOT_FOUND && (record.dados === null || record.dados === undefined)) return 'not_found';
    throw new IndeterminateError(PROVIDER, 'Rodonaves did not complete the Rodo Aéreo lookup');
  }
  if (record.status !== 1 || !Array.isArray(record.dados)) return invalid('Rodonaves returned an unexpected Rodo Aéreo reply');
  return record;
}

/**
 * Brudam's reply for a Rodo Aéreo minuta: one record naming the minuta, its delivery estimate and
 * its occurrences, newest first. Each occurrence repeats the freight document, the service and
 * the masked names of the sender and recipient, which are never read. Billing records and
 * customer-service tickets are not parcel events and are left out, as are exact repeats.
 */
export function parseBrudam(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRodonavesNumber(raw);
  const record = brudamRecord(payload, number);
  if (record === 'not_found') throw new NotFoundError(PROVIDER, 'Rodonaves has no shipment under this number');
  const rows = record.dados as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('Rodonaves returned too many events');
  const seen = new Set<string>();
  let service = '';
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return invalid('Rodonaves returned an invalid Rodo Aéreo event');
    const description = text(row.descricao, 200, 'Rodo Aéreo event') || invalid('Rodonaves returned a Rodo Aéreo event without its wording');
    const code = codeOf(row.status, 'Rodo Aéreo event code');
    const clock = clockOf(row.data);
    service ||= text(row.servico, 40, 'service');
    if (code !== null && HIDDEN_BRUDAM_CODES.has(code)) continue;
    const key = `${code}|${clock.local_time ?? clock.time}|${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const airport = AIRPORT.exec(description)?.[1];
    const stage = codedStage(code);
    events.push({
      ...clock,
      description,
      ...(airport ? { location: airport } : {}),
      ...(code === null ? {} : { provider_code: code }),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
  }
  const sorted = newestFirst(events);
  if (!sorted[0]) throw new NoHistoryError(PROVIDER, 'Rodonaves lists the minuta without events', { reason: 'listed' });
  // The page names the service Rodo Aéreo ECO for ECONOMICO and Rodo Aéreo for the others.
  const serviceName = service ? (service.toUpperCase() === 'ECONOMICO' ? 'Rodo Aéreo ECO' : 'Rodo Aéreo') : undefined;
  return resultOf(sorted, serviceName ? { service_name: serviceName } : {}, dayOf(record.prev_entrega));
}
