import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { jrsReference } from './number.js';
import { jrsStage } from './status.js';

export const PROVIDER = 'jrs-express';
// A delivered parcel's reply is under 2 kB.
export const JRS_MAX_BYTES = 256 * 1024;
const MAX_ROWS = 200;
// An ISO clock as the tracker writes it: up to seven decimals, then Z, an offset or neither.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
// Manila keeps UTC+08:00 all year.
const MANILA_MS = 8 * 3_600_000;
// An airbill or branch code as the reply names it, a string or a number of digits.
const DIGITS = /^\d{1,12}$/;

/** A reference's airbill and branch code, without the leading zeros the tracker ignores. */
export interface JrsReference {
  reference: string;
  airbill: string;
  branch: string;
}

const unpadded = (digits: string) => digits.replace(/^0+(?=\d)/, '');

/** The reference as the tracker takes it: the airbill, a hyphen and the branch code. */
export function normalizeJrsReference(raw: string): JrsReference {
  const reference = typeof raw === 'string' && raw.length <= 64 ? jrsReference(raw) : undefined;
  if (!reference) throw new InvalidInputError(PROVIDER, 'JRS Express tracks the airbill number with its branch code after a hyphen');
  const [airbill, branch] = reference.split('-') as [string, string];
  return { reference, airbill: unpadded(airbill), branch: unpadded(branch) };
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field: absent, null or a string; anything else is a changed reply. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('JRS Express returned an invalid field');
  return clean(value, max);
}

/** An airbill or branch code the reply names, without leading zeros. */
function identifier(value: unknown): string {
  const digits = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && DIGITS.test(value.trim()) ? value.trim() : '';
  return digits ? unpadded(digits) : invalid('JRS Express returned a scan without its airbill or branch code');
}

/**
 * A scan's clock, read as the tracking page reads it for a reader in the Philippines, with the
 * position that reading gives it among the scans. The page drops a Z, reads the clock in the
 * browser's zone and adds eight hours. A clock written with Z, or without an offset, is UTC, so
 * it shows on Manila's clock and keeps its instant. A release's clock comes with +00:00, which the
 * browser applies before the eight hours are added: in the Philippines the page shows it sixteen
 * hours after its digits, after the branch received the parcel, and that wall clock is kept as
 * `local_time`. Its digits as an instant, or as a Manila wall clock, would come before it.
 */
function scanClock(value: unknown): { clock: { time: string } | { local_time: string }; order: number } {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const offset = match?.[2] && match[2] !== 'Z' ? match[2] : undefined;
  const instant = match ? explicitOffsetTime(`${match[1]}${offset ?? 'Z'}`) : null;
  if (!instant || instant.timestamp < Date.UTC(2001, 0, 1)) return invalid('JRS Express returned an invalid scan time');
  if (!offset) return { clock: { time: instant.iso }, order: instant.timestamp + MANILA_MS };
  const shown = instant.timestamp + 2 * MANILA_MS;
  return { clock: { local_time: new Date(shown).toISOString().slice(0, 19) }, order: shown };
}

/**
 * Reads the tracker's reply for one reference: its scans, oldest first, each naming the airbill
 * (`trackingID`) and branch code (`trackingCode`), which must be the ones asked. A scan keeps its
 * status text, its clock and the branch with its town (`branchLocation`). The receiver, who is the
 * person a release names, the relationship and the remarks, which the page does not show, are
 * not read. A row without a status text, as a test row has, is no scan.
 */
export function parseJrs(payload: unknown, raw: string): CarrierResult {
  const { airbill, branch } = normalizeJrsReference(raw);
  if (!Array.isArray(payload)) return invalid('JRS Express returned an unreadable reply');
  // The reply answers the reference asked and nothing else: an empty list is the tracker's own answer.
  if (payload.length === 0) throw new NotFoundError(PROVIDER, 'JRS Express has no shipment under this airbill and branch code');
  if (payload.length > MAX_ROWS) return invalid('JRS Express returned an oversized history');
  const rows = payload.map((row) => (isRecord(row) ? row : invalid('JRS Express returned an invalid scan')));
  const own = rows.filter((row) => identifier(row.trackingID) === airbill && identifier(row.trackingCode) === branch);
  if (!own.length) throw new IndeterminateError(PROVIDER, 'JRS Express answered for another airbill or branch code');

  const scans = own.flatMap((row, index) => {
    const description = text(row.statusText, 200);
    if (!description) return [];
    const location = text(row.branchLocation, 200);
    const { clock, order } = scanClock(row.dateReceived);
    const event: CarrierEvent = { ...clock, description, ...(location ? { location } : {}), ...jrsStage(description) };
    return [{ event, order, index }];
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'JRS Express lists the shipment without a scan', { reason: 'listed' });
  // Newest first, as the page lists them; scans shown alike keep the reply's order.
  const events = scans.sort((a, b) => b.order - a.order || b.index - a.index).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    expected_delivery: null,
    events,
  };
}
