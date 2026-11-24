import { ChallengeError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { countryName } from '../../places/trackingLocation.js';
import { lionGroup, lionRail, lionScan, statusMap } from './status.js';

export const PROVIDER = '360Lion';
export const LION_MAX_BYTES = 1024 * 1024;

/** The tracker takes several numbers at once, comma-separated, so a number is one token of letters and digits. */
export function normalizeLionNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{8,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The address the public tracking page reads one number's scans from. */
export function lionUrl(number: string): string {
  return `https://toms.360lion.com/prod-api/toms/crossSite/oms/hawbcode/v2?codes=${encodeURIComponent(number)}`;
}

// A number reaches the adapter in capitals and without separators, so the reply's own is compared the same way.
const folded = (value: unknown): string => (typeof value === 'string' ? value.toUpperCase().replace(/[\s.-]/g, '') : '');
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
const BUSY = /频繁|too (?:many|frequent)/i;

/** Read one reply of the tracking service: a parcel, a missing one, or a failure of its own kind. */
export function parseLionReply(status: number, body: string, rawNumber: string): CarrierResult {
  if (status === 404) throw new TransportError(PROVIDER, '360Lion tracking service is unavailable', { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '360Lion answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, '360Lion answered with a page instead of its tracking JSON', { cause });
  }
  // The service wraps every answer in its own code: 200 with the data, another with a message.
  if (isRecord(payload) && typeof payload.code === 'number' && payload.code !== 200) {
    const message = clean(payload.msg, 200);
    if (BUSY.test(message)) throw new RateLimitedError(PROVIDER, undefined, '360Lion is rate limiting tracking requests');
    throw new TransportError(PROVIDER, '360Lion tracking service answered with an error', { status: payload.code });
  }
  return parseLion(isRecord(payload) ? payload.data : undefined, rawNumber);
}

interface Scan { event: CarrierEvent; at: number; index: number }

/**
 * A scan's clock: its wall clock with the hours of its place's offset, "-3" in Argentina and "+8" at
 * Pudong, as the reply states them. The page shows the wall clock alone.
 */
function clockOf(date: unknown, zone: unknown): { iso: string; timestamp: number } | null {
  const wall = typeof date === 'string' ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/.exec(date.trim()) : null;
  const offset = typeof zone === 'string' || typeof zone === 'number' ? /^([+-]?)(\d{1,2})(?:([.:])(\d{1,2}))?$/.exec(String(zone).trim()) : null;
  if (!wall || !offset) return null;
  const hours = Number(offset[2]);
  const minutes = offset[3] === '.' ? Math.round(Number(`0.${offset[4]}`) * 60) : Number(offset[4] ?? 0);
  if (hours > 14 || minutes >= 60) return null;
  const sign = offset[1] === '-' ? '-' : '+';
  return explicitOffsetTime(`${wall[1]}T${wall[2]}${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
}

/** A scan's place: a country by its name, an airport by its code; anything else is not read. */
function placeOf(value: unknown): string {
  const code = clean(value, 8).toUpperCase();
  // ISO keeps AA, QM to QZ, XA to XZ and ZZ for private use: no country.
  if (/^[A-Z]{2}$/.test(code)) return countryCode(code) && !/^(?:AA|Q[M-Z]|X[A-Z]|ZZ)$/.test(code) ? countryName(code, 'en') : '';
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

export function parseLion(data: unknown, rawNumber: string): CarrierResult {
  const number = normalizeLionNumber(rawNumber);
  if (!isRecord(data) || !Array.isArray(data.trackList) || data.trackList.length > 50) throw new SchemaError(PROVIDER, '360Lion returned no parcel list');
  // The page asks for one number and lists it by its own code; a list without that code answers another number.
  const parcel: unknown = (data.trackList as unknown[]).find(item => isRecord(item) && folded(item.hawbCode) === number);
  if (!isRecord(parcel)) throw new SchemaError(PROVIDER, '360Lion did not identify the requested number');
  // The page files a parcel out for delivery under no group, and the reply then names none: its scans decide.
  const group = parcel.groupCode == null ? null : typeof parcel.groupCode === 'string' ? parcel.groupCode : '';
  const filed = group === null ? null : lionGroup(group);
  if (filed === undefined) throw new SchemaError(PROVIDER, '360Lion filed the parcel under a group it does not name');

  const listed = parcel.trackItemList ?? [];
  if (!Array.isArray(listed) || listed.length > 300 || !listed.every(isRecord)) throw new SchemaError(PROVIDER, '360Lion returned an invalid scan list');
  if (group === 'NOT_FOUNT') {
    if (listed.length) throw new SchemaError(PROVIDER, '360Lion listed scans for a parcel it did not find');
    throw new NotFoundError(PROVIDER);
  }

  const scans: Scan[] = listed.map((item, index) => {
    const at = clockOf(item.occurDate, item.timeZone);
    if (!at) throw new SchemaError(PROVIDER, '360Lion returned a scan without a readable clock and offset');
    const code = typeof item.trackCode === 'string' && /^[A-Z0-9_]{1,24}$/.test(item.trackCode) ? item.trackCode : '';
    // The wording the page shows, the last mile's own at destination, else 360Lion's English.
    const description = clean(item.oriDescription, 300) || clean(item.description, 300);
    if (!description) throw new SchemaError(PROVIDER, '360Lion returned a scan without a wording');
    const stage = lionScan(code)?.stage ?? (typeof item.icon === 'string' ? lionRail(item.icon) : undefined);
    const location = placeOf(item.location);
    // The list runs newest first, so an earlier row of the same instant is the later scan.
    return { at: at.timestamp, index: listed.length - index, event: {
      time: at.iso, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } };
  });
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);

  // The group says where the parcel stands; one still moving takes its newest scan's later stage. A
  // delivery stands only while no newer scan may have undone it (`leadingScan`).
  const newest = leadingScan(events, statusMap)?.stage as Stage | undefined;
  const moving = new Set<Stage>(['customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'exception']);
  const stage = group === 'IN_TRANSIT' ? (newest && moving.has(newest) ? newest : 'in_transit')
    : group === 'PRECESSING' ? (newest ?? 'registered')
      : group === 'WARNING' || !filed ? newest : filed.stage;
  if (!stage && !events.some(event => event.stage)) {
    throw new SchemaError(PROVIDER, filed ? '360Lion filed a parcel under "Pre-alert" without a scan that says where it stands'
      : '360Lion filed a parcel under no group without a scan that says where it stands');
  }
  const stated = clean(parcel.lastTrackStatusEn, 120);
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered')?.time : undefined;
  // The page names the destination country in English ("ARGENTINA").
  const destination = countryCode(clean(parcel.destinationCountryEn, 60));
  const summary = { status: stage ? languageStageStatus(stage) : 'unknown' as const,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: stated && !/^未知$/.test(stated) ? stated : filed?.en ?? events[0]?.description ?? null, ...(group ? { provider_code: group } : {}),
    ...(destination ? { destination_country: destination } : {}) };
  if (!events.length) return { ...summary, last_update: null, expected_delivery: null, summary_only: true, events: [] };
  return { ...summary, last_update: events[0]!.time ?? null, expected_delivery: null, ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
