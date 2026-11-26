import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, escapeRegExp } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { sendyStage } from './status.js';

export const PROVIDER = 'sendy-express';
// A parcel's reply is a few kilobytes; its hubs, scans and pieces are bounded below.
export const SENDY_MAX_BYTES = 512 * 1024;
/** The reply, with HTTP 422, for a number the tracker holds no parcel under. */
export const SENDY_NO_UPDATE = 'track_info_no_update';

// The tracker's page upper-cases what is typed and sends it as a path segment; Sendy's own numbers are letters and digits.
const NUMBER = /^[A-Z0-9]{4,40}$/;
// The scan and parcel keys the tracker gives, such as `out_for_delivery`; its page reads them in lower case.
const KEY = /^[a-z][a-z0-9_]{1,60}$/;
const keyOf = (value: unknown): string | undefined => {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  return KEY.test(key) ? key : undefined;
};
// Details that name or reach a person: the recipient, the captain and his phone, the van's plate, an address.
const PERSONAL = /name|phone|mobile|contact|address|plate|signature|email|ic_?no/i;
// A Malaysian mobile number, with or without the country code.
const PHONE = /(?:\+?\b60|\b0)1\d[\s-]?\d{3,4}[\s-]?\d{4}\b/;
// The words that lead to a person in Sendy's wordings, details or not: "by Captain <name>", "Delivered to <name>".
const PERSON_LEAD = /\b(?:by\s+)?captain\b|(?<=\b(?:delivered|received|signed|collected)\s+)(?:to|by|for)\b/i;
// The words a wording cut before a person's details ends on: "Parcel Delivered to", "… by Captain".
const LEAD_IN = /(?:[\s,:;([-]|\b(?:to|by|captain|driver|rider|at|from|contact|call|the)\b)+$/i;
const MAX_SCANS = 300;
const MAX_PIECES = 200;

/** A number for Sendy's tracker. */
export function normalizeSendyNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Sendy tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The error key of the tracker's HTTP 422 reply, such as `track_info_no_update`. */
export function sendyErrorKey(payload: unknown): string | undefined {
  return isRecord(payload) ? keyOf(payload.error) : undefined;
}

const same = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value) === number;

function namesNumber(payload: JsonObject, number: string): boolean {
  if (same(payload.track_no, number) || same(payload.ref_no, number)) return true;
  // A shipment of several pieces lists each piece's number.
  const pieces = Array.isArray(payload.parcel_json) ? payload.parcel_json.slice(0, MAX_PIECES) : [];
  return pieces.some((piece) => isRecord(piece) && same(piece.track_no, number));
}

/** The values of a scan's details that name or reach a person. */
function personalValues(info: unknown): string[] {
  if (!isRecord(info)) return [];
  return Object.entries(info).filter(([key, value]) => PERSONAL.test(key) && typeof value === 'string')
    .map(([, value]) => clean(value, 200)).filter((value) => value.length >= 2);
}

/**
 * A scan's wording up to the first person it names or reaches: "Parcel Delivered to <recipient>" reads
 * "Parcel Delivered", and "Parcel Out for Delivery by Captain <name>, <phone>, …" reads "Parcel Out for Delivery".
 */
function wordingOf(text: string, info: unknown): string {
  // A whole name, so a short one does not cut a word that holds its letters.
  const cuts = personalValues(info).map((value) => text.search(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'u')))
    .filter((index) => index >= 0);
  for (const match of [PHONE.exec(text), PERSON_LEAD.exec(text)]) if (match) cuts.push(match.index);
  if (cuts.length === 0) return text;
  return text.slice(0, Math.min(...cuts)).replace(LEAD_IN, '').trim();
}

function eventOf(scan: unknown, index: number): { event: CarrierEvent & { time: string }; timestamp: number; index: number } {
  if (!isRecord(scan)) return invalid('Sendy returned an invalid scan');
  const code = keyOf(scan.en_name) ?? invalid('Sendy returned an invalid scan key');
  const clock = explicitOffsetTime(scan.created_at) ?? invalid('Sendy returned an invalid scan time');
  const details = isRecord(scan.full_info) ? scan.full_info : {};
  const text = clean(typeof details.description === 'string' ? details.description : scan.content, 500);
  const info = isRecord(details.info) ? details.info : {};
  // The tracker names the courier a parcel is handed to after the scan's wording, as its page does.
  const agent = code === 'transfer_to_3rd_party' ? clean(info.agent, 80) : '';
  const wording = wordingOf(text, info);
  const description = agent ? `${wording || code} (${agent})` : wording || code;
  // The hub the scan names; a delivery names none.
  const location = clean(scan.location, 120);
  const stage = sendyStage(code);
  return {
    event: { time: clock.iso, description, provider_code: code, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
    timestamp: clock.timestamp, index,
  };
}

/**
 * Reads the tracker's reply for one number. Its scans carry an instant each. Names, phones, addresses, the
 * van's plate and position, and proof-of-delivery images stay behind.
 */
export function parseSendy(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.trackings) || !isRecord(payload.info)) return invalid('Sendy returned an unreadable reply');
  if (!namesNumber(payload, number)) throw new IndeterminateError(PROVIDER, 'Sendy answered for another parcel');
  if (payload.trackings.length > MAX_SCANS) return invalid('Sendy returned too many scans');
  // Newest first, as the tracker lists them.
  const events = payload.trackings.map(eventOf)
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);
  const status = keyOf(payload.info.status) ?? '';
  if (payload.info.status != null && !status) return invalid('Sendy returned an invalid parcel status');
  const stage = (sendyStage(status) ?? events.find((event) => event.stage)?.stage) as Stage | undefined;
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'Sendy lists the parcel without scans', { reason: 'listed' });
  const weight = typeof payload.total_weight === 'number' && payload.total_weight > 0 && payload.total_weight < 10_000
    ? payload.total_weight : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(status ? { provider_code: status } : {}),
    last_status_text: events[0]!.description ?? null,
    last_update: events[0]!.time,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}
