import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { repairMisreadUtf8 } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { wanbStage } from './status.js';

export const PROVIDER = 'WanbExpress';
export const ORIGIN = 'https://tracking.wanbexpress.com';
export const API = `${ORIGIN}/TrackPoints/Track`;
/** The tracker's last-mile panel, which names the courier of a shipping service without verification. */
export const COURIER_API = `${ORIGIN}/Common/TrackLastMileCarrier`;
export const MAX_BYTES = 1_000_000;

export function normalizeWanbNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^WNB[A-Z]{2}\d{10}YQ$/.test(number)) throw new InvalidInputError(PROVIDER, 'WanbExpress requires its WNB parcel identifier');
  return number;
}

const CURRENT: Readonly<Record<string, Stage>> = { Delivered: 'delivered', InTransit: 'in_transit', OutForDelivery: 'out_for_delivery' };

/**
 * A scan's place. The linehaul agent's departure names its role, and order data a partner relays
 * before the parcel is handed over, such as the sender still preparing it, names only a country,
 * the destination's: neither is where the parcel was.
 */
function wanbPlace(location: string, stage: Stage | null | undefined): string | undefined {
  const place = clean(repairMisreadUtf8(location), 300);
  if (!place || /^linehaul agent$/i.test(place) || (stage === 'registered' && /^[A-Z]{2}$/.test(place))) return undefined;
  return place;
}

export function parseWanb(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWanbNumber(raw);
  if (!isRecord(payload) || typeof payload.Succeeded !== 'boolean') throw new SchemaError(PROVIDER, 'WanbExpress returned an invalid envelope');
  if (!payload.Succeeded) {
    const error = isRecord(payload.Error) ? payload.Error : {};
    if (error.Code === '0x110012') throw new ChallengeError(PROVIDER, 'WanbExpress requires session verification');
    throw new IndeterminateError(PROVIDER, 'WanbExpress did not complete tracking');
  }
  const data = payload.Data;
  if (!isRecord(data) || typeof data.TrackingNumber !== 'string' || data.TrackingNumber !== number) {
    throw new SchemaError(PROVIDER, 'WanbExpress returned a different parcel identifier');
  }
  if (!Array.isArray(data.TrackPoints) || data.TrackPoints.length > 1000) throw new SchemaError(PROVIDER, 'WanbExpress returned invalid scans');
  if (data.Match === 'Unknown' && !data.TrackPoints.length && data.Metadata === null && data.Status === null) throw new NotFoundError(PROVIDER);
  if (data.Match !== 'ParcelId') throw new IndeterminateError(PROVIDER, 'WanbExpress matched a reference instead of its parcel identifier');
  const events: CarrierEvent[] = data.TrackPoints.map((row) => {
    if (!isRecord(row) || typeof row.Content !== 'string' || !row.Content.trim() || typeof row.Time !== 'string'
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.Time)
      || (row.Status != null && typeof row.Status !== 'string') || (row.Location != null && typeof row.Location !== 'string')) {
      throw new SchemaError(PROVIDER, 'WanbExpress returned an invalid scan');
    }
    const time = explicitOffsetTime(row.Time)?.iso;
    if (!time) throw new SchemaError(PROVIDER, 'WanbExpress returned an invalid scan clock');
    const code = typeof row.Status === 'string' ? row.Status : '';
    // A partner's text can arrive with its UTF-8 read as Latin-1, as DHL's German places do ("KÃ¶ln").
    const content = repairMisreadUtf8(row.Content);
    const mapped = wanbStage(code || null, content);
    const wording = mapped === undefined ? classifyWording(content) : null;
    const location = row.Location ? wanbPlace(row.Location, mapped ?? wording?.stage) : undefined;
    return { description: clean(content, 1000), time,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code.slice(0, 100) } : {}),
      ...(mapped ? { stage: mapped, stage_source: 'carrier' as const } : wording?.stage ? { stage: wording.stage, stage_source: wording.source } : {}) };
  });
  // Scans come oldest first; reversed, those at one instant keep their order newest first.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  if (!events.length) throw new IndeterminateError(PROVIDER, 'WanbExpress returned no scans');
  if (data.Status != null && typeof data.Status !== 'string') throw new SchemaError(PROVIDER, 'WanbExpress returned an invalid status');
  const current = events.find(event => event.stage);
  const mapped = typeof data.Status === 'string' && Object.hasOwn(CURRENT, data.Status) ? CURRENT[data.Status] : undefined;
  const stage = mapped ?? (current?.stage as Stage | undefined);
  const metadata = isRecord(data.Metadata) ? data.Metadata : {};
  const country = (key: string) => typeof metadata[key] === 'string' && /^[A-Z]{2}$/.test(metadata[key]) ? metadata[key] : undefined;
  const delivery = deliveryNumber(metadata, number);
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage,
    current_stage_source: mapped ? 'carrier' : current?.stage_source, events: events.slice(0, 100),
    last_status_text: events[0]!.description, last_update: events[0]!.time,
    ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(country('OriginCountryCode') ? { origin_country: country('OriginCountryCode') } : {}),
    ...(country('DestinationCountryCode') ? { destination_country: country('DestinationCountryCode') } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}) };
}

/** The courier's number, which the tracker shows as `TrackingNo` once WanbExpress has relabelled the parcel. */
function deliveryNumber(metadata: Record<string, unknown>, number: string): string | undefined {
  const value = typeof metadata.TrackingNumber === 'string' && metadata.TrackingNumber.length <= 64 ? normalizeTrackingNumber(metadata.TrackingNumber) : '';
  return /^[A-Z0-9]{4,40}$/.test(value) && value !== number ? value : undefined;
}

/** The shipping service a found parcel travels under, which selects its courier; only with a courier's number. */
export function wanbShippingService(payload: unknown): string | undefined {
  const data = isRecord(payload) && isRecord(payload.Data) ? payload.Data : {};
  const metadata = isRecord(data.Metadata) ? data.Metadata : {};
  const service = metadata.ShippingServiceId;
  return typeof service === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(service) ? service : undefined;
}

/**
 * The courier the last-mile panel names. The catalog must know its name or site, and that
 * carrier's detection must offer the courier's number.
 */
export function withWanbCourier(result: CarrierResult, payload: unknown): CarrierResult {
  const data = isRecord(payload) && payload.Succeeded === true && isRecord(payload.Data) ? payload.Data : {};
  const reference = result.delivery_tracking_number;
  const name = typeof data.Name === 'string' ? clean(data.Name, 80) : '';
  if (!reference || !name) return result;
  const partner = carrierIdFromPartner(name, typeof data.OfficialWebSite === 'string' ? data.OfficialWebSite.slice(0, 300) : '');
  return partner && partner !== 'wanbexpress' && (detectCarrierMatch(reference).candidates as string[]).includes(partner)
    ? { ...result, delivery_carrier: partner } : result;
}
