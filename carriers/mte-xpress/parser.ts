import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
// MTE Xpress tracks on Ship Logic, the portal Internet Express tracks on: the same status codes and wording.
import { HIDDEN_CODES, internetExpressStage, internetExpressWording } from '../internet-express/status.js';

export const PROVIDER = 'MTE Xpress';
export const PROVIDER_ID = 14;

function status(code: unknown) {
  if (typeof code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(code)) {
    throw new SchemaError(PROVIDER, 'Invalid Ship Logic status code');
  }
  return { code, description: internetExpressWording(code), stage: internetExpressStage(code) };
}

export function parseMteXpress(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.shipments)) throw new SchemaError(PROVIDER, 'Invalid shipment envelope');
  const shipment: unknown = payload.shipments[0];
  if (payload.shipments.length !== 1 || !isRecord(shipment) || shipment.provider_id !== PROVIDER_ID
      || ![shipment.custom_tracking_reference, shipment.short_tracking_reference].some(ref => clean(ref, 64).toUpperCase() === number)) {
    throw new IndeterminateError(PROVIDER, 'Reply does not identify one matching MTE Xpress shipment');
  }
  const rows = shipment.tracking_events;
  if (!Array.isArray(rows) || rows.length > 500) throw new SchemaError(PROVIDER, 'Invalid shipment history');
  const history = rows.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.parcel_id !== 'number' || !Number.isSafeInteger(row.parcel_id) || row.parcel_id < 0) {
      throw new SchemaError(PROVIDER, 'Invalid scan record');
    }
    // Piece scans, and the operational events the portal leaves out of the history it shows.
    if (row.parcel_id !== 0 || (typeof row.status === 'string' && HIDDEN_CODES.has(row.status))) return [];
    const clock = explicitOffsetTime(row.date);
    if (!clock) throw new SchemaError(PROVIDER, 'Invalid scan time');
    const scan = status(row.status);
    const location = clean(row.location, 120);
    return [{ timestamp: clock.timestamp, event: {
      time: clock.iso, description: scan.description, provider_code: scan.code,
      ...(location ? { location } : {}),
      ...(scan.stage ? { stage: scan.stage, stage_source: 'carrier_map' } : {}),
    } }];
  });
  if (!history.length) throw new NoHistoryError(PROVIDER);
  const events = history.sort((a, b) => b.timestamp - a.timestamp).map(scan => scan.event);
  const summary = status(shipment.status);
  const current = HIDDEN_CODES.has(summary.code) ? status(events[0]!.provider_code) : summary;
  const delivered = current.stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const service = clean(shipment.service_level_name, 80);
  return {
    status: current.stage ? languageStageStatus(current.stage) : 'unknown',
    ...(current.stage ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    ...(current.code !== events[0]!.provider_code ? { provider_code: current.code } : {}),
    last_status_text: current.description,
    last_update: events[0]!.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(service ? { service_name: service } : {}),
    events,
  };
}
