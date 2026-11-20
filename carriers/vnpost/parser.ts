import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { vnpostStage } from './status.js';

export const PROVIDER = 'VNPost';
const MAX_EVENTS = 200;
// The tracker's answer to an accepted captcha for a number it has no item for.
const UNKNOWN_NUMBER = 'Mã bưu gửi không đúng!';
// The customer-service line some scans end with, and the office a scan names last: "(571020: Quang Trung - Quảng Ngãi )".
const HOTLINE = /\s*\(Đầu mối CSKH:[^()]*\)/gu;
const OFFICE = /\s*\((\d{5,6}): ([^()]+)\)$/u;
const FRACTION = /\.\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/i;

/** A whole S10 number, or another item reference of letters and digits the tracker reads. */
export function isVnpostNumber(number: string): boolean {
  return /^[A-Z0-9]{8,30}$/.test(number);
}

function pointOf(latitude: unknown, longitude: unknown) {
  const lat = Number(clean(latitude, 24));
  const lon = Number(clean(longitude, 24));
  // Vietnam's offices only: a missing or misplaced point is left out.
  return lat >= 8 && lat <= 24 && lon >= 102 && lon <= 110 ? { point: { latitude: lat, longitude: lon } } : {};
}

function eventOf(value: unknown): CarrierEvent {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'VNPost returned an unreadable scan');
  // The tracker writes some accents as combining marks; its wording is kept composed.
  const wording = clean(value.StatusText, 400).normalize('NFC');
  // Each scan states its clock with Vietnam's offset, some with fractions of a second.
  const time = explicitOffsetTime(clean(value.TraceDate, 40).replace(FRACTION, ''));
  if (!wording || !time) throw new SchemaError(PROVIDER, 'VNPost returned an unreadable scan');
  const text = wording.replace(HOTLINE, '').trim();
  const office = OFFICE.exec(text);
  const description = office ? text.slice(0, office.index).trim() : text;
  if (!description) throw new SchemaError(PROVIDER, 'VNPost returned an unreadable scan');
  const location = office ? clean(office[2], 120) : clean(value.VI_TRI, 200).normalize('NFC');
  const code = clean(value.Status, 16);
  const classified = vnpostStage(code, description);
  return { time: time.iso, description, ...(description !== wording ? { original_description: wording } : {}),
    ...(location ? { location } : {}), ...pointOf(value.Lat, value.Long), ...(code ? { provider_code: code } : {}),
    ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
}

/** The country code that opens the item's destination, as in "VN - VIETNAM". */
function country(value: unknown): string | null {
  return /^([A-Z]{2}) - /.exec(clean(value, 80))?.[1] ?? null;
}

/**
 * The tracker's reply for one number: the item in `info`, its scans oldest first in `locate`.
 * An answer with `errors.captcha` refused the picture's answer before looking the number up.
 */
export function parseVnpost(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'VNPost returned an unreadable reply');
  if (isRecord(payload.errors) && payload.errors.captcha !== undefined) throw new ChallengeError(PROVIDER, 'VNPost refused the captcha answer');
  if (payload.info === undefined && payload.message === UNKNOWN_NUMBER) throw new NotFoundError(PROVIDER);
  const info = payload.info;
  if (!isRecord(info)) throw new IndeterminateError(PROVIDER, 'VNPost gave an unknown answer for the item');
  if (clean(info.ID, 40).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'VNPost answered for another item');
  // `LO_GUI` 1 is a batch of items sent together, shown as its list of items rather than scans.
  if (info.LO_GUI !== 0 && info.LO_GUI !== '0') throw new IndeterminateError(PROVIDER, 'VNPost answered with a batch of items');
  const locate = payload.locate;
  if (!Array.isArray(locate) || !locate.length) throw new IndeterminateError(PROVIDER, 'VNPost found the item without its history');
  if (locate.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'VNPost returned an excessive history');
  const events = locate.map(eventOf).reverse();
  const newest = events[0]!;
  const staged = events.find(event => event.stage);
  // The routing written in the second of the hand-over to the postman follows it; the hand-over names the state.
  const shown = !newest.stage && staged && staged.time === newest.time ? staged : newest;
  const grams = Number(clean(info.Weight, 12));
  const destination = country(info.Nuoc_Phat);
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: shown.description!, last_update: newest.time!, expected_delivery: null,
    ...(staged?.stage === 'delivered' ? { delivered_at: staged.time! } : {}),
    ...(grams > 0 && grams < 1_000_000 ? { weight_kg: grams / 1000 } : {}),
    ...(destination && destination !== 'VN' ? { destination_country: destination } : {}), events,
  };
}
