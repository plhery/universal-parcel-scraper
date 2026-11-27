import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { daraiiStatus } from './status.js';

export const PROVIDER = 'Daraii';
export const DARAII_MAX_BYTES = 1024 * 1024;
/** The service the public tracking page posts one number to. */
export const DARAII_LOOKUP = 'https://www.kynitha.com/getOrder';

/** The tracker publishes no layout, so a number is one token of letters, digits, hyphens and underscores. */
export function normalizeDaraiiNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{4,39}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

// A number reaches the adapter in capitals and without separators, so the reply's own is compared the same way.
const folded = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).toUpperCase().replace(/[\s./_-]/g, '') : '');
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
// The page cuts a clock to its day and its time of day, so a clock is read only with the offset written after them.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) ?(Z|[+-]\d{2}:?\d{2})$/i;

/** Read one reply of the tracking service: an order's scans, an empty list, or a failure of its own kind. */
export function parseDaraiiReply(status: number, body: string, rawNumber: string): CarrierResult {
  if (status === 404) throw new TransportError(PROVIDER, 'Daraii tracking service is unavailable', { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Daraii answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Daraii answered with a page instead of its tracking JSON', { cause });
  }
  return parseDaraii(payload, rawNumber);
}

function clockOf(value: unknown): ParsedTime | null {
  const match = typeof value === 'string' && value.length <= 40 ? CLOCK.exec(value.trim()) : null;
  return match ? explicitOffsetTime(`${match[1]}T${match[2]}${match[3]}`) : null;
}

/** The code of a scan's status, as the page compares it with 2; null for none. */
function codeOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? value.trim() : null;
}

/** The order's destination, as the page shows it after the arrow. */
function destinationOf(value: unknown): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const country = clean(value, 60);
  if (!country) return {};
  const code = countryCode(country);
  return code ? { destination_country: code } : { destination_country_name: country };
}

interface Scan { event: CarrierEvent; at: number; index: number; row: Record<string, unknown> }

export function parseDaraii(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDaraiiNumber(rawNumber);
  if (!Array.isArray(payload) || payload.length > 500) throw new SchemaError(PROVIDER, 'Daraii returned no scan list');
  // The reply is the order's scans and nothing else, so an order without a scan and a number never issued
  // both get an empty list, which the page reads as a number without tracking information.
  if (!payload.length) throw new IndeterminateError(PROVIDER, 'Daraii holds no scan under the number', { reason: 'portal_not_found' });

  const scans: Scan[] = [];
  for (const [index, row] of payload.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Daraii returned an incomplete scan');
    // Every scan repeats the order's number; a scan of another order is a changed service, not this number's.
    if (folded(row.trackNo) !== folded(number)) throw new SchemaError(PROVIDER, 'Daraii returned a scan of another order');
    const at = clockOf(row.trackTime);
    // The page writes the message into its markup, so tags in it never show.
    const description = textFromHtml(row.trackMessage, 500);
    if (!at || !description) throw new SchemaError(PROVIDER, 'Daraii returned a scan without a message or a clock with an offset');
    scans.push({ at: at.timestamp, index, row, event: { time: at.iso, description } });
  }
  // Newest first, as the page sorts them; scans on one clock keep the reply's order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const newest = scans[0]!;
  // The page states the order's status from its newest scan alone.
  const code = codeOf(newest.row.status);
  const state = daraiiStatus(code);
  if (!code || !state) throw new SchemaError(PROVIDER, 'Daraii returned a scan without a status');
  const events = scans.map(({ event }) => event);
  return {
    status: languageStageStatus(state.stage),
    current_stage: state.stage,
    current_stage_source: 'carrier_map',
    last_status_text: state.wording,
    provider_code: code,
    last_update: newest.event.time ?? null,
    expected_delivery: null,
    ...(state.stage === 'delivered' ? { delivered_at: newest.event.time } : {}),
    ...destinationOf(newest.row.endCountry),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
