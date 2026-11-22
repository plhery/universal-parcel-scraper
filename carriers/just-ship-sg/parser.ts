import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { justShipStage, justShipWording } from './status.js';

export const PROVIDER = 'just-ship-sg';
// A shipment's reply is a few kilobytes.
export const JUST_SHIP_MAX_BYTES = 256 * 1024;

// A shipping ID opens with the day it was booked, as six digits, and goes on in letters and digits.
// The tracking page drops the hyphen it prints after the date, and underscores, before it asks.
const NUMBER = /^\d{6}(?=\d*[A-Z])[A-Z0-9]{4,10}$/;
const CODE = /^[a-z][a-z_]{1,60}$/;
const PARTNER_NUMBER = /^[A-Z0-9]{6,40}$/;
const MAX_EVENTS = 200;
// The services the booking form offers, by the label the tracking page shows for each.
const SERVICES: Readonly<Record<string, string>> = {
  EXPRESS: 'Express Shipping', STANDARD: 'Standard Shipping', POSTAL: 'Postal Shipping', SELECT: 'Select Shipping',
};

/** A JustShip shipping ID; anything else is a number JustShip does not issue. */
export function normalizeJustShipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).replaceAll('_', '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the shipping ID JustShip gave the shipment');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string or null is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return invalid(`JustShip returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Where a scan happened, as the tracking page prints it: the state and the country, never a street. */
function placeOf(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (!isRecord(payload)) return invalid('JustShip returned an invalid scan detail');
  const place = payload.location;
  if (!isRecord(place)) return '';
  const state = typeof place.state === 'string' ? clean(place.state, 80) : '';
  const country = typeof place.country === 'string' ? clean(place.country, 80) : '';
  return [state, countryCode(country) ?? country].filter(Boolean).join(', ');
}

function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('JustShip returned an invalid scan');
  const code = text(row, 'status', 64);
  if (!CODE.test(code)) return invalid('JustShip returned a scan without a status');
  const clock = explicitOffsetTime(text(row, 'createdAt', 64));
  if (!clock) return invalid('JustShip returned a scan without its time');
  const location = placeOf(row.payload);
  const stage = justShipStage(code);
  return {
    time: clock.iso, description: text(row, 'name', 120) || justShipWording(code) || code, provider_code: code,
    ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

/** The carrier JustShip handed the shipment to and that carrier's number, when the reply names both. */
function partnerOf(info: unknown, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (info === null || info === undefined) return {};
  if (!isRecord(info)) return invalid('JustShip returned an invalid carrier');
  const partnerNumber = normalizeTrackingNumber(text(info, 'trackingNumber', 64));
  if (!PARTNER_NUMBER.test(partnerNumber) || partnerNumber === number) return {};
  const partner = carrierIdFromPartner(text(info, 'shippingProvider', 64), text(info, 'url', 500));
  return {
    ...(partner && partner !== PROVIDER && partner !== 'unknown' ? { delivery_carrier: partner } : {}),
    delivery_tracking_number: partnerNumber,
  };
}

/**
 * The reply of `GET /api/shipment/tracking?trackingNumber=`. `{"shipment": null}` is JustShip's
 * answer for a shipping ID it does not know. The shipment must carry the ID asked for. The
 * recipient's town, the packages' sizes and weights and the pickup slot stay behind.
 */
export function parseJustShip(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || !('shipment' in payload)) return invalid('JustShip returned an unexpected reply');
  const { shipment } = payload;
  if (shipment === null) throw new NotFoundError(PROVIDER, 'JustShip has no shipment under this shipping ID');
  if (!isRecord(shipment)) return invalid('JustShip returned an invalid shipment');
  const id = text(shipment, 'shippingID', 64);
  if (!id) return invalid('JustShip returned a shipment without its shipping ID');
  if (normalizeTrackingNumber(id).replaceAll('_', '') !== number) throw new IndeterminateError(PROVIDER, 'JustShip answered for another shipment');

  const rows = payload.trackingHistory ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS) return invalid('JustShip returned an invalid history');
  // The reply lists the history oldest first; the result reads newest first.
  const events = rows.map(eventOf).map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(b.event.time!) - Date.parse(a.event.time!) || b.index - a.index).map(({ event }) => event);
  const destination = countryCode(text(shipment, 'recipientCountry', 64));
  const service = SERVICES[text(shipment, 'shippingMethod', 32)];
  const partner = partnerOf(payload.trackingInfo, number);
  if (events.length === 0) {
    throw new NoHistoryError(PROVIDER, 'JustShip lists the shipment without a history', { reason: 'listed',
      deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number });
  }
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...partner,
    events,
  };
}
