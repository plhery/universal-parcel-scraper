import { DateTime } from 'luxon';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { apdStage, apdWording, statusMap } from './status.js';

export const PROVIDER = 'APD';
export const APD_TRACKER = 'https://online.apdparcel.com.au/track';
// A delivered label with its signature image is about fifteen kilobytes.
export const APD_MAX_BYTES = 1024 * 1024;
// APD's scans are Adelaide's, the only place it delivers.
const ZONE = 'Australia/Adelaide';
// R, seven digits and the label's check letter, which the tracker verifies and leaves out of the item it answers.
const LABEL = /^(R\d{7})([A-Z])?$/;
const TRACKING_DATA = /\bvar\s+trackingData\s*=\s*(\{[^\n]*\});[ \t]*\r?$/m;
const STAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|g-recaptcha|h-captcha|awswaf/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A label: R, seven digits and its check letter, or the seven digits alone, as the tracker takes it. */
export function normalizeApdNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!LABEL.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The item the tracker answers for a label: R and its seven digits. */
export function apdItem(number: string): string {
  return LABEL.exec(normalizeApdNumber(number))![1]!;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function clock(stamp: unknown): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const digits = STAMP.exec(typeof stamp === 'string' ? stamp : '');
  if (!digits) return invalid('APD returned a scan without a readable clock');
  const [, year, month, day, hour, minute, second] = digits;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  // Luxon rolls an impossible clock over, so only one that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) invalid('APD returned a scan without a readable clock');
  const time = isoTime(wall, ZONE);
  if (!time) return invalid('APD returned a scan without a readable clock');
  return { local_time: wall, time: time.iso, time_zone: ZONE, time_zone_basis: 'carrier' };
}

/** The tracker's page: the `trackingData` its script renders, or a failure of its own kind. */
export function parseApdPage(html: string, number: string): CarrierResult {
  const script = TRACKING_DATA.exec(html);
  if (!script) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'APD answered with a verification page');
    return invalid('APD answered without its tracking data');
  }
  let data: unknown;
  try {
    data = JSON.parse(script[1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'APD returned unreadable tracking data', { cause });
  }
  return parseApdTracking(data, number);
}

interface Scan { event: CarrierEvent; at: number; index: number }

/** One label's `trackingData`: its scans, newest first, bound to the label asked. */
export function parseApdTracking(data: unknown, raw: string): CarrierResult {
  const number = normalizeApdNumber(raw);
  const item = apdItem(number);
  const query = isRecord(data) ? data.query : undefined;
  const head = isRecord(query) && isRecord(query['@attributes']) ? query['@attributes'] : undefined;
  if (!isRecord(query) || !head) return invalid('APD returned no tracking query');
  if (head.style !== 'item') invalid('APD answered for something other than a label');
  if (head.status === 'failed') {
    // The tracker answers a label it does not know, or one with the wrong check letter, with the key it was given.
    if (clean(head.reason, 120).toLowerCase() === 'no history found' && (head.item === item || head.item === number)) throw new NotFoundError(PROVIDER);
    invalid('APD could not read the label');
  }
  if (head.status !== 'success') invalid('APD returned an unknown query status');
  if (head.item !== item) invalid('APD did not identify the requested label');
  // The XML behind the reply gives one scan as an object and several as a list.
  const rows: unknown[] = query.track === undefined ? [] : Array.isArray(query.track) ? query.track : [query.track];
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) invalid('APD returned too long a history');

  const scans: Scan[] = [];
  let signedBy = '';
  for (const [index, row] of rows.entries()) {
    const scan = isRecord(row) && isRecord(row['@attributes']) ? row['@attributes'] : undefined;
    if (!scan) return invalid('APD returned an unreadable scan');
    if (scan.item !== item) invalid('APD returned a scan of another label');
    const action = clean(scan.action, 40);
    const description = apdWording(action, clean(scan.actionDescription, 120));
    if (!action || !description) invalid('APD returned a scan without its action');
    const times = clock(scan.stamp);
    const stage = apdStage(action);
    if (action === 'deliver') signedBy = clean(scan.signatureName, 120) || signedBy;
    scans.push({ at: Date.parse(times.time!), index, event: {
      ...times, description, provider_code: action,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  // The tracker lists the oldest scan first.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    // The name the driver took with the signature, which the page shows beside the delivery.
    ...(delivered && signedBy ? { signed_by: signedBy } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
