import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { countryCode, epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gfsStage } from './status.js';

export const PROVIDER = 'GFS Express';
const NUMBER = /^[0-9A-Z]{6,40}$/;
/** The gateway's code for an answered call. */
const ANSWERED = 1001;
const MAX_ITEMS = 10;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A GFS Express number, in upper case. */
export function normalizeGfsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GFS Express numbers are six to forty letters and digits');
  return number;
}

const invalid = (message: string) => new SchemaError(PROVIDER, message);

function text(value: unknown, field: string, maxLength: number): string {
  if (value != null && typeof value !== 'string') throw invalid(`GFS Express returned an invalid ${field}`);
  return clean(value, maxLength);
}

/** The scans, newest first: the reply lists them so, and rows of the same second keep its order. */
function eventsOf(tracks: unknown): CarrierEvent[] {
  if (tracks == null) return [];
  if (!Array.isArray(tracks) || tracks.length > MAX_ROWS) throw invalid('GFS Express changed its scan list');
  const rows = tracks.map((track, index) => {
    if (!isRecord(track)) throw invalid('GFS Express returned an invalid scan');
    const description = text(track.description, 'scan wording', 300);
    if (!description) throw invalid('GFS Express returned a scan without wording');
    // The page shows each scan's seconds since the epoch on the reader's own clock.
    const time = Number.isSafeInteger(track.timestamp) ? epochSecondsTime(track.timestamp) : null;
    if (!time) throw invalid('GFS Express returned an invalid scan time');
    const stage = gfsStage(normalizeStatusWording(description));
    return { index, at: time.timestamp, event: { time: time.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
  });
  rows.sort((left, right) => right.at - left.at || left.index - right.index);
  return rows.map(({ event }) => event);
}

/**
 * GFS Express's answer: the gateway's code, and under `data` one record per number asked, with the
 * countries the parcel goes between and its scans. A number GFS does not hold comes back as its echo alone.
 */
export function parseGfs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGfsNumber(raw);
  if (!isRecord(payload) || !Number.isSafeInteger(payload.code)) throw invalid('GFS Express returned an invalid tracking reply');
  if (payload.code !== ANSWERED) throw invalid(`GFS Express refused the tracking page's request (code ${payload.code as number})`);
  const { data } = payload;
  if (!Array.isArray(data) || data.length > MAX_ITEMS || !data.every(isRecord)) throw invalid('GFS Express returned an invalid tracking reply');
  const items = data.filter(item => typeof item.trackingNo === 'string' && normalizeTrackingNumber(item.trackingNo) === number);
  if (items.length !== 1) throw new IndeterminateError(PROVIDER, 'GFS Express did not answer for the number asked');
  const item = items[0]!;
  const events = eventsOf(item.tracks);
  if (!events.length) throw new IndeterminateError(PROVIDER, 'GFS Express does not hold the number yet', { reason: 'portal_not_found' });

  const decider = events.find(event => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const latest = events[0]!;
  const delivered = stage === 'delivered' ? decider!.time : undefined;
  const destination = countryCode(text(item.toCountry, 'destination country', 60));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: (decider ?? latest).description!,
    last_update: latest.time ?? null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
