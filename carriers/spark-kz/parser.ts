import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { sparkStage } from './status.js';

export const PROVIDER = 'Spark';
export const SPARK_MAX_BYTES = 128_000;
// The order service's invoice lookup; `lang=en` gives its English wordings.
export const sparkEndpoint = (number: string) =>
  `https://gateway.spark.kz/order/api/v1/track-invoice/${encodeURIComponent(number)}?lang=en`;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// The service's not-found answer, in Russian whatever the language asked.
const NOT_FOUND = /^Не найдены статусы по накладной/;
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied|request rejected/i;
// A step the service has done, cancelled, or plans; only the first two happened.
const STATES = new Set(['completed', 'canceled', 'waiting']);
const MAX_STEPS = 100;

/** Spark's waybill numbers read `SP` and eight digits; the tracker publishes no layout, so any short code passes. */
export function normalizeSparkNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{6,20}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The service's reply: its JSON for a number it knows, and an HTTP 404 with a message for one it does not. */
export function sparkReply(status: number, body: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a verification page`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with a page instead of its tracking JSON`, { cause });
  }
  if (status === 404) {
    if (isRecord(payload) && payload.success === false && NOT_FOUND.test(clean(payload.message, 200))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, `${PROVIDER} answered HTTP 404 without its not-found message`);
  }
  return payload;
}

const unreadable = (what: string) => new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable ${what}`);

/** A `DD.MM.YYYY` day as `YYYY-MM-DD`, or null when the service leaves it out. */
function day(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const match = typeof value === 'string' ? DAY.exec(value) : null;
  if (!match) throw unreadable(what);
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw unreadable(what);
  return iso;
}

interface Scan { index: number; event: CarrierEvent & { local_time: string }; wording: string; classified: ClassifiedWording | null }

/**
 * The invoice's steps: the service lists every step of its route, done, cancelled or planned,
 * each dated to the day. Done and cancelled steps with a day are its history, newest first;
 * a planned step's forecast day is not.
 */
export function parseSpark(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSparkNumber(rawNumber);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) throw unreadable('reply');
  const data = payload.data;
  if (clean(data.invoiceNumber, 40).replace(/[\s-]+/g, '').toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  if (!Array.isArray(data.statusHistory) || data.statusHistory.length > MAX_STEPS) throw unreadable('history');
  const scans: Scan[] = [];
  data.statusHistory.forEach((row, index) => {
    if (!isRecord(row) || typeof row.state !== 'string' || !STATES.has(row.state)) throw unreadable('step');
    const wording = clean(row.statusName, 160);
    const code = typeof row.statusCode === 'number' && Number.isInteger(row.statusCode) ? String(row.statusCode) : '';
    if (!wording || !code) throw unreadable('step');
    const date = day(row.date, 'step date');
    // A done step can lack its day, as an order's creation once its pickup is cancelled.
    if (row.state === 'waiting' || !date) return;
    const classified = sparkStage(code, wording);
    scans.push({ index, wording, classified, event: {
      local_time: date,
      description: wording,
      provider_code: code,
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the invoice without a dated step`, { reason: 'listed' });
  // Newest first; the service's route order settles steps of one day.
  scans.sort((left, right) => right.event.local_time.localeCompare(left.event.local_time) || right.index - left.index);
  const newest = scans[0]!;
  const stage = newest.classified;
  // The day the service predicts for delivery holds only while the parcel is on its way.
  const open = !stage || !['delivered', 'exception', 'returned'].includes(stage.stage);
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: newest.wording,
    last_update: null,
    last_update_local: newest.event.local_time,
    expected_delivery: open ? day(data.predictedDate, 'predicted date') : null,
    events: scans.map(scan => scan.event),
  };
}
