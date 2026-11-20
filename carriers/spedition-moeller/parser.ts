import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForCode } from './status.js';

export const provider = 'spedition-moeller';
export const referencePattern = /^(?:00)?\d{18}$/;

function nve(value: unknown): string | undefined {
  const code = clean(value);
  return referencePattern.test(code) ? code.slice(-18) : undefined;
}

function parseEvent(value: unknown): CarrierEvent & { stage?: Stage } {
  if (!isRecord(value)) throw new SchemaError(provider, 'Invalid Artur Möller movement');
  const code = clean(value.code, 40);
  const wording = clean(value.text, 180);
  if (!code && !wording) throw new SchemaError(provider, 'Artur Möller movement lacks a status');
  const clock = explicitOffsetTime(value.timestamp);
  const mapped = stageForCode(code);
  const stage = mapped ?? trackingLanguageStage(wording);
  const city = clean(value.city, 90);
  const country = clean(value.country, 60);
  const location = countryCode(country) && /^[\p{L} .’'-]+$/u.test(city) && !hasPrivateDeliveryDetails(city)
    ? `${city}, ${country}` : undefined;
  return {
    ...(code ? { provider_code: code } : {}),
    ...(wording && !hasPrivateDeliveryDetails(wording) ? { description: wording } : {}),
    ...(clock ? { time: clock.iso } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
    ...(location ? { location } : {}),
  };
}

export function parseTracking(body: unknown, reference: string): CarrierResult {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.tracking)) {
    throw new SchemaError(provider, 'Artur Möller omitted the public tracking response');
  }
  const tracking = body.tracking;
  if (typeof tracking.found !== 'boolean' || !Array.isArray(tracking.shipments)) {
    throw new SchemaError(provider, 'Artur Möller omitted the lookup result');
  }
  const requested = nve(reference);
  if (!requested || nve(tracking.searched_value) !== requested) {
    throw new IndeterminateError(provider, 'Artur Möller returned a different package lookup');
  }
  if (!tracking.found && tracking.shipments.length === 0) throw new NotFoundError(provider);
  if (!tracking.found || nve(tracking.searched_barcode) !== requested) {
    throw new IndeterminateError(provider, 'Artur Möller did not confirm the requested barcode');
  }
  const matches = (tracking.shipments as unknown[]).filter(isRecord).filter(shipment =>
    Array.isArray(shipment.packages) && (shipment.packages as unknown[]).some(piece =>
      isRecord(piece) && nve(piece.barcode) === requested));
  if (matches.length !== 1) throw new IndeterminateError(provider, 'Artur Möller did not return one matching shipment');
  const shipment = matches[0]!;
  if (!Array.isArray(shipment.timeline)) throw new SchemaError(provider, 'Artur Möller omitted the scan timeline');

  // The public page reverses the API’s oldest-first timeline.
  const events = shipment.timeline.map(parseEvent).reverse();
  const current = shipment.current_status == null ? events[0] : parseEvent(shipment.current_status);
  if (!current) throw new NoHistoryError(provider);
  const { stage } = current;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    ...(current.provider_code ? { provider_code: current.provider_code } : {}),
    ...(stage === 'delivered' && current.time ? { delivered_at: current.time } : {}),
    last_status_text: current.description ?? null,
    last_update: current.time ?? null,
    ...(events.length === 0 ? { summary_only: true } : {}),
    events,
  };
}
