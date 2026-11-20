import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { orderComparableScans } from '../../core/result/order.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { memphisStage, statusMap } from './status.js';

export const CARRIER = 'memphis-courier';
export const PROVIDER = 'Memphis Courier';
export const MEMPHIS_MAX_BYTES = 512 * 1024;
/** The lookup Memphis Courier's client tracking page makes; the page's software supplier hosts it. */
export const MEMPHIS_TRACKING_API = 'https://testapi.bitechsolucoes.com.br/api/tracking/found-house';

/** The tracker looks a shipment up by its code: one token of letters and digits. */
export function normalizeMemphisNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{6,30}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The page's lookup for one code, without the optional customer account. */
export function memphisUrl(number: string): string {
  return `${MEMPHIS_TRACKING_API}?account=&trackingNumber=${encodeURIComponent(number)}`;
}

const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
const folded = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '');

/** Read one reply of the tracking service: a shipment, a missing one, or a failure of its own kind. */
export function parseMemphisReply(status: number, body: string, rawNumber: string): CarrierResult {
  if (status === 404) throw new TransportError(PROVIDER, 'Memphis Courier tracking service is unavailable', { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Memphis Courier answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Memphis Courier answered with a page instead of its tracking JSON', { cause });
  }
  // The service says whether the lookup ran; a failed one carries its messages instead of items.
  if (isRecord(payload) && payload.success === false) throw new TransportError(PROVIDER, 'Memphis Courier tracking service answered with an error');
  return parseMemphis(payload, rawNumber);
}



/**
 * A scan's clock: the service's wall clock, which states an offset only where it ends with one.
 * A fraction of a second is kept to the millisecond, the precision results carry.
 */
function clockOf(value: unknown): { local_time: string } | { time: string } | null {
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim()) : null;
  if (!match) return null;
  const [, wall, fraction, offset] = match;
  // A day or an hour out of range does not round-trip, such as 30 February.
  const date = new Date(`${wall!}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== wall) return null;
  const millis = (fraction ?? '').slice(0, 3).padEnd(3, '0');
  const clock = millis === '000' ? wall : `${wall}.${millis}`;
  if (!offset) return { local_time: clock };
  const instant = explicitOffsetTime(`${clock}${offset}`);
  return instant ? { time: instant.iso } : null;
}

export function parseMemphis(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeMemphisNumber(rawNumber);
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.items) || payload.items.length > 20) {
    throw new SchemaError(PROVIDER, 'Memphis Courier returned no shipment list');
  }
  if (!payload.items.length) throw new NotFoundError(PROVIDER);
  // The page lists every shipment the code finds under its own code; only the requested one answers.
  const house: unknown = (payload.items as unknown[]).find((item) => isRecord(item) && folded(item.codigo) === number);
  if (!isRecord(house)) throw new SchemaError(PROVIDER, 'Memphis Courier did not identify the requested shipment');

  const listed = house.events ?? [];
  if (!Array.isArray(listed) || listed.length > 300 || !listed.every(isRecord)) throw new SchemaError(PROVIDER, 'Memphis Courier returned an invalid scan list');
  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  listed.forEach((item) => {
    const clock = clockOf(item.date);
    if (!clock) throw new SchemaError(PROVIDER, 'Memphis Courier returned a scan without a readable clock');
    const description = clean(item.description, 300);
    if (!description) throw new SchemaError(PROVIDER, 'Memphis Courier returned a scan without a wording');
    const code = typeof item.code === 'string' && /^[A-Z0-9_]{2,12}$/.test(item.code.trim()) ? item.code.trim() : '';
    const stage = code ? memphisStage(code) : undefined;
    // The page's country or state column.
    const location = clean(item.location, 80);
    const event: CarrierEvent = { ...clock, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    // Two scans apart by less than a millisecond stay apart by the service's own fraction.
    const identity = JSON.stringify([String(item.date).trim(), event]);
    if (seen.has(identity)) return;
    seen.add(identity);
    // The list runs newest first, so an earlier row of the same clock is the later scan.
    scans.push(event);
  });
  const events = orderComparableScans(scans, event => event.time ? 'instant' : 'wall:' + (event.location ?? ''));

  const newest = events[0];
  // A delivery stands only while no newer scan may have undone it (`leadingScan`).
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  const weight = typeof house.totalWeight === 'number' && Number.isFinite(house.totalWeight) && house.totalWeight > 0 && house.totalWeight < 10_000
    ? house.totalWeight : undefined;
  const summary: CarrierResult = { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest?.description ?? '', expected_delivery: null, ...(weight ? { weight_kg: weight } : {}) };
  if (!newest) return { ...summary, last_update: null, summary_only: true, events: [] };
  return { ...summary, last_update: newest.time ?? null, ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
