import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { shipterStage } from './status.js';

export const PROVIDER = 'Shipter';
export const SHIPTER_ENDPOINT = 'https://shiptertracking.com:3963/tracking/getTracks';
const NUMBER = /^H3[A-Z]{2}\d{5,6}KR$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The API's event clock and the date column of its official tracking page both state GMT offsets.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?: GMT([+-])((?:[01]\d|2[0-3])):([0-5]\d))?$/;

export function normalizeShipterNumber(raw: string): string {
  const number = raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shipter requires its own H3 shipment number');
  return number;
}

function field(row: JsonObject, key: string, max = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Shipter returned an invalid ${key}`);
  return clean(value, max);
}

/** The whole identity is compared before display-text limits are applied. */
function ownIdentity(row: JsonObject): string {
  if (typeof row.in_track_no !== 'string') throw new SchemaError(PROVIDER, 'Shipter returned a record without its own shipment number');
  return row.in_track_no.replace(/\s+/g, '').toUpperCase();
}

function eventClock(value: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const parts = CLOCK.exec(value);
  if (!parts || !calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]))
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    throw new SchemaError(PROVIDER, 'Shipter returned an invalid scan clock');
  }
  const local = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
  if (!parts[7]) return { local_time: local };
  const parsed = explicitOffsetTime(`${local}${parts[7]}${parts[8]}:${parts[9]}`);
  if (!parsed) throw new SchemaError(PROVIDER, 'Shipter returned an invalid scan offset');
  return { time: parsed.iso };
}

function eventOf(value: unknown): CarrierEvent {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Shipter returned an invalid scan');
  const description = field(value, 'content');
  if (!description) throw new SchemaError(PROVIDER, 'Shipter returned a scan without its wording');
  if (typeof value.time !== 'string' || value.time.length > 64) throw new SchemaError(PROVIDER, 'Shipter returned an invalid scan clock');
  const clock = eventClock(value.time.trim());
  const location = field(value, 'location', 200);
  const mapped = shipterStage(null, normalizeStatusWording(description));
  const classified = classifyWording(description, 'pending');
  const staged = mapped ? { stage: mapped, stage_source: 'carrier_map' }
    : classified.source === 'none' ? {} : { stage: classified.stage, stage_source: classified.source };
  return { ...clock, description, ...(location ? { location } : {}), ...staged };
}

function serviceReply(payload: JsonObject): void {
  if (payload.err !== undefined) {
    if (typeof payload.err !== 'string') throw new SchemaError(PROVIDER, 'Shipter returned an invalid error envelope');
    // This separate envelope is the observed absence signature. An arbitrary err, an empty
    // success list or an expired response is not an answer about the requested shipment.
    if (payload.err === 'no result' && Array.isArray(payload.deliveries) && payload.deliveries.length === 0
      && Object.keys(payload).every((key) => key === 'err' || key === 'deliveries')) throw new NotFoundError(PROVIDER);
    if (/too many requests|rate limit|요청.{0,8}초과/i.test(payload.err)) throw new RateLimitedError(PROVIDER);
    if (/captcha|verify (?:that )?you are human|access denied|request (?:was )?blocked/i.test(payload.err)) {
      throw new ChallengeError(PROVIDER, 'Shipter requires verification');
    }
    throw new IndeterminateError(PROVIDER, 'Shipter did not complete the lookup');
  }
  if (payload.suc !== 1) {
    if (payload.suc !== undefined) throw new IndeterminateError(PROVIDER, 'Shipter did not complete the lookup');
    throw new SchemaError(PROVIDER, 'Shipter returned an invalid tracking envelope');
  }
}

/** One record of Shipter's official guest service, bound by its own in_track_no. */
export function parseShipter(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShipterNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Shipter returned an invalid tracking envelope');
  serviceReply(payload);
  if (!Array.isArray(payload.result) || payload.result.length > 30) throw new SchemaError(PROVIDER, 'Shipter returned an invalid record list');
  if (!payload.result.length) throw new IndeterminateError(PROVIDER, 'Shipter returned an empty result without its absence signature');
  const records = payload.result.map((value) => {
    if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Shipter returned an invalid shipment record');
    return value;
  });
  const bound = records.filter((row) => ownIdentity(row) === number);
  if (bound.length !== 1) throw new IndeterminateError(PROVIDER, 'Shipter did not identify one matching shipment');
  const row = bound[0]!;
  if (!Array.isArray(row.events) || row.events.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shipter returned an invalid history');
  if (row.status !== undefined && row.status !== null && (typeof row.status !== 'string' || row.status.length > 64)) {
    throw new SchemaError(PROVIDER, 'Shipter returned an invalid summary status');
  }
  const summary = field(row, 'status', 64);
  const summaryStage = summary === 'delivered' ? 'delivered' : undefined;
  const destination = field(row, 'destination', 200).toUpperCase();
  const country = /^[A-Z]{2}$/.test(destination) ? destination : '';
  const facts = { expected_delivery: null, ...(country ? { destination_country: country } : {}) };
  if (!row.events.length) {
    if (!summaryStage) throw new NoHistoryError(PROVIDER, 'Shipter has no scans for the shipment');
    return { ...facts, status: 'delivered', current_stage: summaryStage, current_stage_source: 'carrier_map',
      last_status_text: summary, last_update: null, events: [], summary_only: true };
  }
  const seen = new Set<string>();
  const events = row.events.map(eventOf).filter((event) => {
    const key = JSON.stringify([event.time ?? event.local_time, event.description, event.location]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // An offset-less clock cannot be compared with an instant. Such a mixed history keeps
  // the service's newest-first order instead of dating its wall clocks on a guessed zone.
  if (events.every((event) => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const newest = events[0]!;
  // An older delivery may have been undone by a newer, unresolved scan.
  const firstStaged = events.find((event) => event.stage);
  const current = newest.stage ? newest : firstStaged && !['delivered', 'returned'].includes(firstStaged.stage!) ? firstStaged : undefined;
  const stage = current?.stage as Stage | undefined;
  return { ...facts,
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(stage === 'delivered' && current?.time ? { delivered_at: current.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS || (summaryStage && stage !== summaryStage) ? { history_truncated: true } : {}),
  };
}
