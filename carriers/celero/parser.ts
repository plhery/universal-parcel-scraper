import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { celeroStage } from './status.js';

export const PROVIDER = 'Celero';
export const CELERO_MAX_BYTES = 256_000;
/** The service Celero's tracking form posts its numbers to, run by the vendor of its ERP. */
export const CELERO_ENDPOINT = 'https://sigma.mu/tracking/track_api.php';
export const CELERO_PAGE = 'https://celerogroup.com/';

const NUMBER = /^[A-Z0-9]{6,40}$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// A remark that is a bare reference, such as the customs declaration's, rather than wording.
const REFERENCE = /^[A-Z0-9/-]+$/i;
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
const MAX_SCANS = 200;

/** Celero publishes no layout; the tracker matches the whole number it is given. */
export function normalizeCeleroNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Celero tracks numbers of six to forty letters and digits');
}

export function celeroJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Celero answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Celero answered with a page instead of its tracking JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Celero returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The scan's wall clock, which the tracker gives without a zone, or its day alone when the clock reads midnight. */
function clockOf(written: string): string {
  const clock = CLOCK.exec(written);
  const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
  if (!clock || !day || Number(clock[4]) > 23 || Number(clock[5]) > 59 || Number(clock[6]) > 59) {
    throw new SchemaError(PROVIDER, 'Celero returned an unreadable scan time');
  }
  return written.endsWith(' 00:00:00') ? day : `${day}T${clock[4]}:${clock[5]}:${clock[6]}`;
}

interface Scan { event: CarrierEvent; id: number }

function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Celero returned an invalid scan');
  if (text(row, 'awb_num', 64).toUpperCase().replace(/\s+/g, '') !== number) throw new SchemaError(PROVIDER, 'Celero answered for another number');
  const id = row.ID;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new SchemaError(PROVIDER, 'Celero returned a scan without its record number');
  const status = text(row, 'awb_status', 120);
  if (!status) throw new SchemaError(PROVIDER, 'Celero returned a scan without a status');
  // A fault or remark in words says more than the status; a bare reference or a repeat of the status does not.
  const notes = [...new Set([text(row, 'awb_fault', 200), text(row, 'awb_remarks', 300)]
    .filter(note => note && !REFERENCE.test(note) && normalizeStatusWording(note) !== normalizeStatusWording(status)))];
  const stage = celeroStage(status);
  return {
    id,
    event: {
      local_time: clockOf(text(row, 'awb_date', 40)),
      description: [status, ...notes].join(': '),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
    },
  };
}

/**
 * The reply of `POST track_api.php` with `{"awbs":[number]}`: each number asked, mapped to its
 * scans, newest first, each a record number, the number, a wall clock, a status, a fault and a
 * remark. A number Celero does not know maps to an empty list.
 */
export function parseCelero(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeCeleroNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Celero returned no answer');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Celero did not answer the lookup');
  if (isRecord(payload.errors) && payload.errors[number] !== undefined) throw new IndeterminateError(PROVIDER, 'Celero could not look the number up');
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Celero returned no tracking data');
  const rows = payload.data[number];
  if (rows === undefined) throw new IndeterminateError(PROVIDER, 'Celero answered without the requested number');
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Celero returned an invalid history');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Celero returned an oversized history');

  // The record numbers follow the order Celero wrote the scans in, which places a scan dated by its day alone.
  const scans = rows.map(row => scanOf(row, number));
  if (new Set(scans.map(scan => scan.id)).size !== scans.length) throw new SchemaError(PROVIDER, 'Celero returned a scan twice');
  scans.sort((left, right) => right.id - left.id);
  const events = scans.map(scan => scan.event);
  const latest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}
