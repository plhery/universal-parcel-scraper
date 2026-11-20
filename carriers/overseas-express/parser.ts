import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { overseasStage } from './status.js';

export const PROVIDER = 'Overseas Express';
export const OVERSEAS_MAX_BYTES = 256_000;
/** I-NET's guest lookup, which the tracking page on `inet.overseas.hr` calls. */
export const OVERSEAS_URL = 'https://inetapi.overseas.hr/NesyIntegration/GetGuestShipmentDetails';
export const OVERSEAS_ORIGIN = 'https://inet.overseas.hr';
/** I-NET's platform number for Croatia. */
const PLATFORM = 201;
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required|403 Forbidden)|_cf_chl_opt|captcha|access denied|request rejected/i;
const MAX_SCANS = 200;
const MAX_PARCELS = 100;

export type OverseasField = 'Reference' | 'ExternalId';

/** The page takes eight to sixteen letters or digits; a parcel number is printed in groups. */
export function normalizeOverseasNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{8,16}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/**
 * The fields the page asks, in order: a parcel number goes as `Reference`, and a fourteen-digit
 * shipment number as `ExternalId`. The page tries a fourteen-character code as a parcel number too.
 */
export function overseasFields(number: string): OverseasField[] {
  return /^\d{14}$/.test(number) ? ['ExternalId', 'Reference'] : ['Reference'];
}

export function overseasRequest(number: string, field: OverseasField): Record<string, string | number> {
  return { Platform: PLATFORM, [field]: number };
}

/** The shipment of a reply that found one; an unknown code is a 400 inside an HTTP 200. */
export function overseasPayload(body: string): Record<string, unknown> {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a verification page`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with a page instead of its tracking JSON`, { cause });
  }
  if (!isRecord(reply)) throw unreadable('reply');
  const message = text(reply.resultMessage, 160);
  if (reply.resultCode === 200) {
    if (!isRecord(reply.payload)) throw unreadable('shipment');
    return reply.payload;
  }
  if (reply.resultCode === 400 && /^barcodes ?not ?found$/i.test(message)) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, `${PROVIDER} refused the lookup: ${message || 'no reason given'}`);
}

const unreadable = (what: string) => new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable ${what}`);
const text = (value: unknown, max = 60) => (typeof value === 'string' ? clean(value, max) : '');

/**
 * Whether the shipment is the one the number names: its shipment number, or a parcel number. A
 * parcel number reads as three digits, three digits, the eight-digit code customers enter and two
 * more digits, so the eight digits name it too.
 */
function names(details: Record<string, unknown>, number: string): boolean {
  if ([details.shipmentId, details.externalId].some(value => text(value).toUpperCase() === number)) return true;
  const parcels = Array.isArray(details.parcels) ? details.parcels.slice(0, MAX_PARCELS) : [];
  const codes = [details.legacySystemCargoId, ...parcels.map(parcel => (isRecord(parcel) ? parcel.legacySystemShortBarcode : undefined))]
    .map(value => text(value).toUpperCase()).filter(Boolean);
  return codes.some(code => code === number || (/^\d{8}$/.test(number) && /^\d{16}$/.test(code) && code.slice(6, 14) === number));
}

/** A UTC instant; I-NET writes its scans with `Z`. */
function instant(value: unknown): string {
  const stamp = typeof value === 'string' ? value : '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?Z$/.exec(stamp);
  const date = match ? new Date(`${match[1]}Z`) : null;
  if (!match || !date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== match[1]) throw unreadable('scan time');
  return `${match[1]}Z`;
}

interface Scan { index: number; at: number; event: CarrierEvent & { time: string; description: string }; classified: ClassifiedWording | null }

/** The shipment's scans, newest first, in English when the lookup asks for it. */
export function parseOverseas(payload: Record<string, unknown>, rawNumber: string): CarrierResult {
  const number = normalizeOverseasNumber(rawNumber);
  const details = payload.shipmentDetails;
  if (!isRecord(details)) throw unreadable('shipment');
  if (!names(details, number)) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const list = payload.eventDetailList;
  if (!Array.isArray(list) || list.length > MAX_SCANS) throw unreadable('history');
  const scans: Scan[] = list.map((row, index) => {
    if (!isRecord(row)) throw unreadable('scan');
    const legacy = text(row.legacySystemShortEventCode, 12).toUpperCase();
    const type = text(row.eventType, 80);
    const code = legacy || type;
    const wording = text(row.description, 240) || type;
    if (!code || !wording) throw unreadable('scan');
    const time = instant(row.timeStamp);
    const location = text(row.hubName, 80);
    const classified = overseasStage(legacy, type, wording);
    return { index, at: Date.parse(time), classified, event: {
      time,
      description: wording,
      provider_code: code,
      ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    } };
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the shipment without a scan`, { reason: 'listed' });
  // Newest first; the service lists scans of one moment newest first too.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const newest = scans[0]!;
  const current = scans.find(scan => scan.classified);
  const stage = current?.classified?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.classified!.source } : {}),
    last_status_text: newest.event.description,
    last_update: newest.event.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.event.time } : {}),
    events: scans.map(scan => scan.event),
  };
}
