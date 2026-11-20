import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { MILESTONES, onexStage } from './status.js';

export const PROVIDER = 'Onex';
export const MAX_BYTES = 256_000;
const MAX_EVENTS = 300;
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}:\d{2})?$/;
// The tracker's database writes an unset date as zeros.
const ZERO = /^0000-00-00\b/;
/** The import's and the export's dates, in the order the page shows them, with the page's captions' codes. */
const IMPORT = [['wo_scanneddate', 'import-scanned'], ['inusadate', 'import-identified'], ['inmywaydate', 'import-departed'],
  ['inarmeniadate', 'import-in-armenia'], ['receiveddate', 'import-received']] as const;
const EXPORT = [['created_at', 'export-received'], ['two_date', 'export-departed'], ['third_date', 'export-arrived'],
  ['four_date', 'export-posted']] as const;

/** A number as the tracker takes it: letters and digits, upper case, without spaces. */
export function normalizeOnexNumber(raw: string): string {
  const number = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

function unreadable(what: string): SchemaError {
  return new SchemaError(PROVIDER, `Onex returned an unreadable ${what}`);
}

/** A date's wall clock, or null when the tracker has none. */
function clockOf(value: unknown): string | null {
  if (value === null || value === undefined || value === false || value === '') return null;
  const text = clean(value, 40);
  if (!text || ZERO.test(text)) return null;
  const match = CLOCK.exec(text);
  if (!match) throw unreadable('date');
  return `${match[1]}T${match[2]}`;
}

function dayOf(value: unknown): string | undefined {
  const text = clean(value, 40);
  return text && !ZERO.test(text) ? DAY.exec(text)?.[1] : undefined;
}

interface Scan { key: string; event: CarrierEvent & { local_time: string; description: string }; stage?: Stage; source?: string }

function scan(local_time: string, description: string, code?: string, location?: string): Scan {
  const classified = onexStage(code, description);
  return {
    key: JSON.stringify([local_time, code ?? description, location ?? '']),
    event: { local_time, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) },
    ...(classified ? { stage: classified.stage, source: classified.source } : {}),
  };
}

function listed(value: unknown): Scan {
  if (!isRecord(value)) throw unreadable('event');
  const description = clean(value.event_description, 300);
  const clock = clockOf(value.date);
  if (!description || !clock) throw unreadable('event');
  const location = clean(value.location, 120) || (isRecord(value.pickup_point) ? clean(value.pickup_point.long_name, 120) : '');
  return scan(clock, description, undefined, location || undefined);
}

function dated(record: Record<string, unknown>, dates: typeof IMPORT | typeof EXPORT): Scan[] {
  return dates.flatMap(([field, code]) => {
    const clock = clockOf(record[field]);
    return clock ? [scan(clock, MILESTONES.get(code)!, code)] : [];
  });
}

function side(value: unknown): Record<string, unknown> | null {
  if (value === false || value === null || value === undefined) return null;
  if (!isRecord(value)) throw unreadable('record');
  return value;
}

/**
 * The tracker's answer for one number: the events of an order Onex delivers in Armenia, or the
 * dates of a parcel it carries into or out of Armenia, each on a wall clock the reply does not
 * place in a zone. Another carrier's scans of the inbound parcel are not Onex's and are not read.
 */
export function parseOnex(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !isRecord(payload.data)) throw unreadable('reply');
  if (Number(payload.status) !== 1) throw new SchemaError(PROVIDER, 'Onex did not answer the lookup');
  const data = payload.data;
  const imported = side(data.import), exported = side(data.export);
  let list: unknown[] = [];
  if (Array.isArray(data.iherb)) list = data.iherb;
  else if (data.iherb !== false && data.iherb !== null && data.iherb !== undefined) throw unreadable('history');
  if (list.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Onex returned an excessive history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const one of [...list.map(listed), ...(imported ? dated(imported, IMPORT) : []), ...(exported ? dated(exported, EXPORT) : [])]) {
    if (seen.has(one.key)) continue;
    seen.add(one.key);
    scans.push(one);
  }
  if (!scans.length) {
    // The page's own test: none of the four records means no parcel by that number.
    if (imported || exported || Array.isArray(data.iherb) || (data.track !== false && data.track !== null && data.track !== undefined)) {
      throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
    }
    throw new NotFoundError(PROVIDER);
  }
  // Newest first by wall clock; a stable sort keeps the reply's order within one second.
  scans.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time));
  const events = scans.map((one) => one.event);
  const newest = events[0]!;
  const current = scans.find((one) => one.stage);
  const stage = current?.stage;
  const settled = stage === 'delivered' || stage === 'returned';
  // The page shows an estimate until the import is received or the export posted.
  const estimate = imported && !clockOf(imported.receiveddate) && cleanScalar(imported.no_estimated_date, 4) !== '1'
    ? dayOf(imported.estdate) ?? dayOf(imported.estimateddate)
    : exported && !clockOf(exported.four_date) ? dayOf(exported.estdate) ?? dayOf(exported.estimateddate) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current?.stage ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: (current?.event ?? newest).description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: !settled && estimate ? estimate : null,
    events,
  };
}
