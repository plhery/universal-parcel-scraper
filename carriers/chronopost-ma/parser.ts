import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { chronopostMaStage } from './status.js';

export const PROVIDER = 'Chronopost Maroc';
export const CHRONOPOST_MA_MAX_BYTES = 256_000;
// The lookup the tracking page's script posts the number to, with `Mode` 2, its web service.
export const CHRONOPOST_MA_ENDPOINT = 'https://chronopost.ma/umbraco/Surface/TrackingSurface/GetTrackingEvents';
const DATE = /^\/Date\((\d{10,14})\)\/$/;
// The site's error page for its tracking service's own HTTP status.
const BACKEND_STATUS = /<title>\s*Response status code does not indicate success: (\d{3}) \(\)\.\s*<\/title>/;
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied|request rejected/i;
// The service writes a missing reason as dashes.
const NO_REASON = /^-*$/;

/** The tracker publishes no layout; it matches a number in capitals and without spaces. */
export function normalizeChronopostMaNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{8,30}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/**
 * The service's reply: JSON for a number its tracking service knows; for one it does not, the
 * site's HTTP 500 error page relaying that service's 404.
 */
export function chronopostMaReply(status: number, body: string): unknown {
  if (status === 500) {
    const backend = BACKEND_STATUS.exec(body.slice(0, 4_000))?.[1];
    if (backend === '404') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, `${PROVIDER}'s tracking service failed${backend ? ` with HTTP ${backend}` : ''}`);
  }
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a verification page`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with a page instead of its tracking JSON`, { cause });
  }
}

const unreadable = (what: string) => new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable ${what}`);
const folded = (value: unknown): string => (typeof value === 'string' ? value.replace(/[\s-]+/g, '').toUpperCase() : '');

/**
 * An event's wall clock. `EventDate` carries it as if it were UTC, and `EventHour` repeats its
 * time of day; the service states no zone.
 */
function wallClock(row: Record<string, unknown>): string {
  const match = typeof row.EventDate === 'string' ? DATE.exec(row.EventDate) : null;
  const date = match ? new Date(Number(match[1])) : null;
  if (!date || Number.isNaN(date.getTime())) throw unreadable('event date');
  const wall = date.toISOString().slice(0, 19);
  const hour = clean(row.EventHour, 12);
  if (hour && !(/^\d{6}$/.test(hour) && hour === wall.slice(11, 19).replaceAll(':', ''))) throw unreadable('event time');
  return wall;
}

interface Scan { event: CarrierEvent & { local_time: string }; wording: string; classified: ClassifiedWording | null }

function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw unreadable('event');
  if (![row.SendingNumber, row.AssociatedNumber].some(value => folded(value) === number)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const wording = clean(row.EventName, 160);
  if (!wording) throw unreadable('event');
  const reason = clean(row.Reason, 160);
  const place = clean(row.Place, 120);
  const classified = chronopostMaStage(wording);
  const event = {
    local_time: wallClock(row),
    description: NO_REASON.test(reason) ? wording : `${wording} (${reason})`,
    ...(place ? { location: place } : {}),
    ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
  };
  return { event, wording, classified };
}

/** The tracker's history for one number: its events, newest first, each on a wall clock without a zone. */
export function parseChronopostMa(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeChronopostMaNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.AllTrackingEvents) || !('LastEvent' in payload)) throw unreadable('reply');
  if (payload.AllTrackingEvents.length > 200) throw unreadable('reply');
  if (payload.LastEvent === null) {
    // The page shows its "no data" block for this answer.
    if (payload.AllTrackingEvents.length) throw unreadable('reply');
    throw new NotFoundError(PROVIDER);
  }
  // The page's summary: the event it calls the last one, which heads the list.
  const last = scanOf(payload.LastEvent, number);
  const scans = payload.AllTrackingEvents.map(row => scanOf(row, number));
  const newest = scans[0] ?? last;
  const stage = newest.classified;
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: newest.wording,
    last_update: null,
    last_update_local: newest.event.local_time,
    events: (scans.length ? scans : [last]).map(scan => scan.event),
  };
}
