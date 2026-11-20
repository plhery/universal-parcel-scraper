import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { peddlerStage } from './status.js';

export const PROVIDER = 'Peddler';
export const MAX_BYTES = 256_000;
const MAX_EVENTS = 200;
const MISSING = 'Consignment not found';

/** A number as the tracker's form takes it: letters and digits, upper case. */
export function normalizePeddlerNumber(raw: string): string {
  const number = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

function eventOf(value: unknown): CarrierEvent & { time: string; description: string } {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Peddler returned an unreadable event');
  const time = explicitOffsetTime(value.ts);
  const english = isRecord(value.details) && isRecord(value.details.lang) && isRecord(value.details.lang.en) ? value.details.lang.en : {};
  const headline = clean(english.headline, 200);
  if (!time || !headline) throw new SchemaError(PROVIDER, 'Peddler returned an unreadable event');
  // A failed attempt's reason, as the page shows it under the headline.
  const comment = isRecord(value.lang) ? clean(value.lang.en, 300) : '';
  const code = cleanScalar(value.code, 8);
  const classified = peddlerStage(code, headline);
  return { time: time.iso, description: comment ? `${headline}: ${comment}` : headline,
    ...(code ? { provider_code: code } : {}), ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
}

/**
 * The tracker's reply for one number, as the browser service passes it on: the events oldest
 * first, each with its instant and its wording in English and Dutch. A number the tracker does
 * not know gets an error; one it knows without any event comes back with the number alone.
 */
export function parsePeddler(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Peddler returned an unreadable reply');
  if (payload.error !== undefined) {
    if (payload.error === MISSING) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Peddler did not answer for the number');
  }
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Peddler returned an unreadable reply');
  if (cleanScalar(data.inquiryNumber, 40).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Peddler answered for another number');
  const parcel = data.package;
  if (parcel === undefined || parcel === null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(parcel) || !Array.isArray(parcel.events)) throw new SchemaError(PROVIDER, 'Peddler returned an unreadable history');
  const list: unknown[] = parcel.events;
  if (!list.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  if (list.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Peddler returned an excessive history');
  const events = list.map(eventOf).sort((a, b) => b.time.localeCompare(a.time));
  const newest = events[0]!;
  const staged = events.find(event => event.stage);
  const delivered = staged?.stage === 'delivered';
  const eta = delivered ? null : explicitOffsetTime(parcel.estimatedDeliveryDate)?.iso ?? null;
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: newest.description, last_update: newest.time, expected_delivery: eta,
    ...(delivered ? { delivered_at: staged.time } : {}),
    timezone: 'Europe/Amsterdam', events,
  };
}
