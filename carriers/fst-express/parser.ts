import { DateTime, FixedOffsetZone } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { fstStage, statusMap } from './status.js';

export const PROVIDER = 'fst-express';
// A one-piece job is under ten kilobytes; each piece adds its own scans.
export const FST_MAX_BYTES = 1024 * 1024;
/** The zone the tracker shows its clocks in, which orders a scan that comes without its instant. */
const ZONE = 'Australia/Sydney';

// The tracker finds a job by FST's job number, the consignment number it carries and the sender's
// reference, so the adapter takes any run of letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// The tracker's whole answer for a number it holds no job under: "no information was found for this waybill number".
const NOT_FOUND = '未查询到该运单号的信息';
// The fields a job names the numbers it is found by in.
const IDENTITIES = ['jobno', 'refno', 'oldrefno', 'referenceno', 'referencenoOrigin'] as const;
// "2025-07-25 12:01:00": the scan's wall clock.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z0-9]{1,12}$/;
const DESTINATION = /^([A-Z]{2})-/;
// The hub FST hands a job to, as its codes name Australia Post's: "Aupost-SYD9721", "Auspost-SYD-9721".
const AUSTRALIA_POST_HUB = /\bau(?:s)?post\b/i;
const AUSTRALIA_POST_SCAN = /\bby Australia Post\b/i;
const MAX_JOBS = 20;
const MAX_ROWS = 500;
const MAX_PIECES = 200;
const MAX_OFFSET_MINUTES = 14 * 60;

/** A number for FST Express's tracker, in capitals; anything else is not one it takes. */
export function normalizeFstNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FST Express tracks job numbers and references of six to forty letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`FST Express returned an invalid ${key}`);
}

/**
 * A scan's clock. `scanTime` is the wall clock the page shows and `scanDatetime` the same moment
 * in epoch milliseconds; their difference is the offset the tracker shows it at, so the scan is
 * that instant at that offset. A scan without the instant, or whose two clocks do not differ by
 * an offset a clock can have, keeps its wall clock and is ordered on Sydney time.
 */
function clockOf(row: Record<string, unknown>): { at: number; clock: Pick<CarrierEvent, 'time' | 'local_time'> } {
  const wall = text(row, 'scanTime', 32);
  const parts = CLOCK.exec(wall);
  const local = parts ? `${parts[1]}T${parts[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  const digits = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parts || !digits.isValid || digits.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) return invalid('FST Express returned an invalid scan time');
  const kept = () => ({ at: zonedTime(wall, 'yyyy-MM-dd HH:mm:ss', ZONE)?.timestamp ?? digits.toMillis(), clock: { local_time: local } });
  const raw = row.scanDatetime;
  if (raw === null || raw === undefined || raw === '') return kept();
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return invalid('FST Express returned an invalid scan timestamp');
  // The page shows the clock to the second.
  const at = Math.floor(raw / 1000) * 1000;
  const minutes = (digits.toMillis() - at) / 60_000;
  if (!Number.isInteger(minutes) || minutes % 15 !== 0 || Math.abs(minutes) > MAX_OFFSET_MINUTES) return kept();
  const time = DateTime.fromMillis(at, { zone: FixedOffsetZone.instance(minutes) }).toISO({ suppressMilliseconds: true });
  return time ? { at, clock: { time } } : kept();
}

interface Scan { index: number; at: number; event: CarrierEvent }

/** One row of the job's history, as the page shows it: the remark, the place and the clock. */
function scanOf(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) return invalid('FST Express returned an invalid scan');
  const code = text(row, 'scanCode', 20).toUpperCase();
  if (code && !CODE.test(code)) return invalid('FST Express returned an invalid scan code');
  // The page shows the remark alone; the status name stands in for an empty one.
  const description = text(row, 'remark', 500) || text(row, 'scanStatus', 100);
  const { at, clock } = clockOf(row);
  if (!description) return null;
  const location = text(row, 'location', 200) || text(row, 'scanStation', 200);
  const staged = fstStage(code, description);
  return { index, at, event: {
    ...clock, description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The job's scans, newest first as the page lists them, with a row it repeats once. */
function eventsOf(job: Record<string, unknown>): CarrierEvent[] {
  const rows = job.podInfoDTOList ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('FST Express returned an invalid history');
  const seen = new Set<string>();
  const scans = rows.map(scanOf).filter((scan): scan is Scan => {
    if (!scan) return false;
    const { time, local_time: local, provider_code: code, description, location } = scan.event;
    const key = JSON.stringify([time ?? local, code ?? '', description, location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  // The reply lists the newest first, so of two scans at one instant the first is the newer.
  return scans.sort((a, b) => b.at - a.at || a.index - b.index).map((scan) => scan.event);
}

/** The numbers a job is found by, as the tracker compares them. */
function identities(job: Record<string, unknown>): string[] {
  return IDENTITIES.map((key) => normalizeTrackingNumber(text(job, key, 64))).filter(Boolean);
}

/** The one job of the reply that names the number asked. */
function jobOf(jobs: readonly unknown[], number: string): Record<string, unknown> {
  const own = jobs.filter((job): job is Record<string, unknown> => {
    if (!isRecord(job) || !text(job, 'jobno', 64)) return invalid('FST Express returned a job without its number');
    return identities(job).includes(number);
  });
  if (own.length === 0) throw new IndeterminateError(PROVIDER, 'FST Express answered for another job');
  if (new Set(own.map((job) => normalizeTrackingNumber(text(job, 'jobno', 64)))).size > 1) {
    throw new IndeterminateError(PROVIDER, 'FST Express lists several jobs under this reference');
  }
  return own[0]!;
}

/** The pieces' numbers, which are Australia Post's article numbers when it delivers the job. */
function pieceNumbers(job: Record<string, unknown>): string[] {
  const pieces = job.childTrack ?? [];
  if (!Array.isArray(pieces) || pieces.length > MAX_PIECES) return invalid('FST Express returned invalid pieces');
  return pieces.map((piece) => (isRecord(piece) ? normalizeTrackingNumber(text(piece, 'childNo', 64))
    : invalid('FST Express returned an invalid piece'))).filter(Boolean);
}

/**
 * Australia Post and the number it tracks the job under, when the job goes out through an
 * Australia Post hub or Australia Post's own scans name it, and its rules offer that number:
 * the consignment number the job carries, else the article number of its one piece.
 */
function handoff(job: Record<string, unknown>, events: readonly CarrierEvent[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const viaAustraliaPost = ['hubOutCode', 'hubOutName'].some((key) => AUSTRALIA_POST_HUB.test(text(job, key, 80)))
    || events.some((event) => AUSTRALIA_POST_SCAN.test(event.description ?? ''));
  if (!viaAustraliaPost) return {};
  const offered = (number: string) => /^[A-Z0-9]{4,40}$/.test(number)
    && (detectCarrierMatch(number).candidates as string[]).includes('australia-post');
  const consignment = normalizeTrackingNumber(text(job, 'refno', 64));
  const articles = pieceNumbers(job).filter(offered);
  const number = offered(consignment) ? consignment : articles.length === 1 ? articles[0] : undefined;
  return number ? { delivery_carrier: 'australia-post', delivery_tracking_number: number } : {};
}

/**
 * The reply of the tracker's `POST /tms-saas-oms/expose/traceQueryResult`: `result_code` 0 and
 * the jobs found under the number, or 1 and the not-found sentence. The job must name the number
 * asked. The sender's and recipient's names, addresses and phones, the goods and the charges stay
 * behind, as do the pieces' own lists, which repeat the job's.
 */
export function parseFst(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFstNumber(raw);
  if (!isRecord(payload) || typeof payload.result_code !== 'number') return invalid('FST Express returned an invalid reply');
  if (payload.result_code !== 0) {
    if (payload.result_code === 1 && payload.body === NOT_FOUND) throw new NotFoundError(PROVIDER, 'FST Express has no job under this number');
    throw new IndeterminateError(PROVIDER, 'FST Express did not complete the lookup');
  }
  const jobs = payload.body;
  if (!Array.isArray(jobs) || jobs.length > MAX_JOBS) return invalid('FST Express returned an invalid job list');
  if (jobs.length === 0) throw new IndeterminateError(PROVIDER, 'FST Express answered without a job');
  const job = jobOf(jobs, number);
  const events = eventsOf(job);
  const destination = countryCode(DESTINATION.exec(text(job, 'destName', 80))?.[1] ?? text(job, 'reCountry', 8));
  const partner = handoff(job, events);
  // The page shows a job without scans as a number it could not find, but the tracker holds the job.
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'FST Express lists the job without scans', { reason: 'listed',
      deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number });
  }

  const newest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && lead?.time ? lead.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...partner,
    events,
  };
}
