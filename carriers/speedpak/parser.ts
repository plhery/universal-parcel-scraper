import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { countryCode, epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedpakStatus } from './status.js';

const PROVIDER = 'SpeedPAK';

export function normalizeSpeedpakNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^E[ES][A-Z0-9]{26}$/.test(number)) throw new InvalidInputError(PROVIDER, 'SpeedPAK requires a 28-character EE or ES tracking number');
  return number;
}

export function parseSpeedpak(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSpeedpakNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'SpeedPAK did not complete the tracking lookup');
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.waybills) || !Array.isArray(result.notExistsTrackingNumbers)) {
    throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid shipment list');
  }
  if (result.waybills.length === 0) {
    if (result.notExistsTrackingNumbers.length === 1 && clean(result.notExistsTrackingNumbers[0]) === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'SpeedPAK returned no identity-bound shipment');
  }
  if (result.waybills.length !== 1 || result.notExistsTrackingNumbers.length) throw new SchemaError(PROVIDER, 'SpeedPAK returned ambiguous shipments');
  const shipment: unknown = result.waybills[0];
  if (!isRecord(shipment) || clean(shipment.trackingNumber) !== number) throw new SchemaError(PROVIDER, 'SpeedPAK returned a different shipment');
  if (!Array.isArray(shipment.traces) || shipment.traces.length > 1000) throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid history');
  if (!shipment.traces.length) throw new IndeterminateError(PROVIDER, 'SpeedPAK returned no shipment activity');
  const events: CarrierEvent[] = [];
  const handoffs = new Set<string>();
  for (const row of shipment.traces) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid history row');
    const description = clean(row.eventDesc);
    if (!description) throw new SchemaError(PROVIDER, 'SpeedPAK returned an empty scan description');
    const time = epochMillisTime(row.oprTimestamp);
    const mapped = speedpakStatus(description);
    const location = [clean(row.oprCity), clean(row.oprCountry)].filter(Boolean).join(', ');
    const handoff = /^LM Carrier:\s*\[([^\]]+)\]\s*,\s*LM tracking No[.．]?\s*[:：]\s*\[([A-Z0-9]{4,40})\]$/.exec(description);
    if (handoff) handoffs.add(`${handoff[1]!.trim().toLowerCase()}|${handoff[2]}`);
    const event: CarrierEvent = { description, ...(time ? { time: time.iso } : { provider_time_text: clean(row.oprTime) || undefined }),
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    if (!events.some(previous => JSON.stringify(previous) === JSON.stringify(event))) events.push(event);
  }
  // The website's trace array is already newest first. Keep undated scans in
  // that order rather than borrowing an older timestamp for the summary.
  const wording = clean(shipment.lastStatus) || events[0]!.description!;
  const mapped = speedpakStatus(wording);
  const latest = events[0]!;
  const output: CarrierResult = { status: mapped?.status ?? 'unknown', last_status_text: wording, last_update: latest.time ?? null,
    ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    ...(mapped?.stage === 'delivered' && latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    events: events.slice(0, 100) };
  const country = countryCode(shipment.consigneeCountryCode);
  if (country) output.destination_country = country;
  if (handoffs.size === 1) {
    const [name, reference] = [...handoffs][0]!.split('|');
    if (name === 'uni uni' || name === 'uniuni') output.delivery_carrier = 'uniuni';
    output.delivery_tracking_number = reference!;
  }
  return output;
}
