import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isRecord } from '../../core/types.js';
import { smtStage, statusMap } from './status.js';

export const PROVIDER = 'southwestern-motor-transport';
/** Each screen carries its whole layout, about 105 kB. */
export const SMT_MAX_BYTES = 1024 * 1024;

// The trace screen's entry field holds eleven digits, and the trace reads them as a number.
const NUMBER = /^\d{6,11}$/;
// A firewall's, CDN's or bot check's page in place of the screen's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The Profound UI session id the screen's address carries.
const SESSION = /^[0-9A-F]{64}$/i;
// The trace screen's record format, and the history subfile of a trace by SMT PRO.
const SCREEN = 'TRACEBY';
const HISTORY = 'TRACEPRO';
const COLUMNS = ['SHPCTY', 'SHPDATE', 'SHPSTS', 'SHPTIME'] as const;
// "10/22/2026", and "8:30:00" or "10:55:00": the terminal's wall clock, without a zone.
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// A town and its state, as "ANGLETON, TX".
const PLACE = /^\p{L}[\p{L} .'-]{0,59}, [A-Z]{2}$/u;
// The row after a delivery that gives the signer's name where the others give the town.
const SIGNED = /^signed by$/i;
const POUNDS = /^\d{1,7}$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 200;

/** A PRO as the trace reads it: six to eleven digits, leading zeros dropped. */
export function normalizeSmtNumber(raw: string): string {
  const typed = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const number = NUMBER.test(typed) ? typed.replace(/^0+/, '') : '';
  if (!number) throw new InvalidInputError(PROVIDER, 'Southwestern Motor Transport tracks PROs of six to eleven digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A screen as JSON, or the reason it is not one. */
export function smtJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Southwestern Motor Transport answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Southwestern Motor Transport returned a reply that is not its screen', { cause });
  }
}

/**
 * The screen a Profound UI reply shows: its record format's name, fields and subfiles. A reply
 * that did not run, or a screen other than the trace, such as the one for an ended session,
 * proves nothing about the shipment.
 */
function traceScreen(payload: unknown): { data: Record<string, unknown>; subfiles: Record<string, unknown> } {
  if (!isRecord(payload) || typeof payload.success !== 'boolean') return invalid('Southwestern Motor Transport returned an unexpected reply');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Southwestern Motor Transport could not show its trace screen');
  const layers = payload.layers;
  if (!Array.isArray(layers) || layers.length !== 1 || !isRecord(layers[0]) || !Array.isArray(layers[0].formats)) {
    return invalid('Southwestern Motor Transport returned a screen without its layout');
  }
  const formats = layers[0].formats as unknown[];
  const format = formats.length === 1 && isRecord(formats[0]) ? formats[0] : invalid('Southwestern Motor Transport returned an unexpected screen');
  if (format.name !== SCREEN) throw new IndeterminateError(PROVIDER, 'Southwestern Motor Transport showed another screen than its trace');
  if (!isRecord(format.data)) return invalid('Southwestern Motor Transport returned a screen without its fields');
  return { data: format.data, subfiles: isRecord(format.subfiles) ? format.subfiles : {} };
}

/** The session id of a newly opened trace screen. */
export function parseSmtSession(payload: unknown): string {
  traceScreen(payload);
  const psid = isRecord(payload) ? payload.psid : undefined;
  return typeof psid === 'string' && SESSION.test(psid) ? psid : invalid('Southwestern Motor Transport opened a screen without its session');
}

/** A field of the screen: a string, else a changed reply. */
function field(data: Record<string, unknown>, name: string, max = 120): string {
  const value = data[name];
  if (value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`Southwestern Motor Transport returned an invalid ${name}`);
}

/** "10/22/2026" as 2026-10-22, calendar-checked. */
function isoDay(value: string): string | null {
  const parts = DAY.exec(value);
  return parts ? calendarDay(Number(parts[3]), Number(parts[1]), Number(parts[2])) : null;
}

/** A row's wall clock: its day and, when given, its time. The trace names no zone. */
function wallClock(day: string, time: string): string {
  const date = isoDay(day) ?? invalid('Southwestern Motor Transport returned an invalid row date');
  if (!time) return date;
  const clock = CLOCK.exec(time) ?? invalid('Southwestern Motor Transport returned an invalid row time');
  return `${date}T${clock[1]!.padStart(2, '0')}:${clock[2]}:${clock[3] ?? '00'}`;
}

/** The trace's rows, newest first, without the signer's row. */
function history(subfiles: Record<string, unknown>): CarrierEvent[] {
  const subfile = subfiles[HISTORY];
  if (subfile === undefined) return [];
  if (!isRecord(subfile) || !Array.isArray(subfile.data) || !Array.isArray(subfile['field names'])) {
    return invalid('Southwestern Motor Transport returned an invalid trace');
  }
  const names = subfile['field names'] as unknown[];
  const at = COLUMNS.map((column) => names.indexOf(column));
  if (at.some((index) => index < 0)) return invalid('Southwestern Motor Transport returned a trace without its columns');
  const rows = subfile.data as unknown[];
  if (rows.length > MAX_ROWS) return invalid('Southwestern Motor Transport returned an oversized trace');
  const events = rows.flatMap((row): CarrierEvent[] => {
    if (!Array.isArray(row) || row.length !== names.length || row.some((cell) => typeof cell !== 'string')) {
      return invalid('Southwestern Motor Transport returned an invalid trace row');
    }
    const [place, day, status, time] = at.map((index) => clean(row[index], 120)) as [string, string, string, string];
    if (!status) return invalid('Southwestern Motor Transport returned a trace row without its status');
    if (SIGNED.test(status)) return [];
    const staged = smtStage(status);
    return [{
      local_time: wallClock(day, time),
      description: status,
      ...(PLACE.test(place) ? { location: place } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    }];
  });
  // The trace lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(value: string): number | null {
  const pounds = POUNDS.test(value) ? Number(value) : 0;
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/** The delivery appointment's day, else the due day; a day before the newest row's is stale. */
function estimate(data: Record<string, unknown>, events: readonly CarrierEvent[]): string | null {
  const day = isoDay(field(data, 'APPTDATE', 10)) ?? isoDay(field(data, 'DUEDATE', 10));
  const newest = events[0]?.local_time?.slice(0, 10);
  return day && !(newest && day < newest) ? day : null;
}

/**
 * The trace screen after a trace by SMT PRO (`TRACEBY.FHPRO`): the shipment's PRO, status line,
 * pickup, delivery appointment, due and delivery days, weight and its rows, newest first, each
 * with its town, day, status and time. A PRO the trace does not find clears the entry and shows
 * the empty screen without a message, which proves nothing.
 *
 * The signer's name, in its own row and in the summary line, the bill of lading, the purchase
 * order and the towns of the shipper and consignee are never read.
 */
export function parseSmtTrace(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSmtNumber(raw);
  const { data, subfiles } = traceScreen(payload);
  const shown = field(data, 'SHPPRO', 16);
  if (!/^\d{1,11}$/.test(shown)) return invalid('Southwestern Motor Transport returned a screen without its PRO');
  const pro = shown.replace(/^0+/, '');
  const status = field(data, '$STAT', 60);
  const events = history(subfiles);
  if (!pro) {
    if (status || events.length) return invalid('Southwestern Motor Transport showed a trace without its PRO');
    throw new IndeterminateError(PROVIDER, 'Southwestern Motor Transport showed no shipment for the PRO and gave no reason');
  }
  if (pro !== number) throw new IndeterminateError(PROVIDER, 'Southwestern Motor Transport answered for another PRO');

  const headline: ClassifiedWording | null = status ? smtStage(status) : null;
  if (!events.length && !headline) throw new NoHistoryError(PROVIDER, 'Southwestern Motor Transport lists the shipment without a trace', { reason: 'listed' });
  // The status line settles a delivery; otherwise the newest staged row leads, and the line stands in without one.
  const lead = leadingScan(events, statusMap);
  const decided: ClassifiedWording | null = headline?.stage !== 'delivered' && lead?.stage
    ? { stage: lead.stage as Stage, source: lead.stage_source ?? 'carrier_map' }
    : headline;
  const newest = events[0];
  const weight = weightKg(field(data, 'SHPWGT', 10));
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: newest?.description ?? status,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    expected_delivery: decided?.stage === 'delivered' ? null : estimate(data, events),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
