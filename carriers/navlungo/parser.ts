import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Navlungo';

export function navlungoNumber(input: string): string {
  const number = input.trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a 12-character Navlungo domestic tracking number');
  return number;
}

function readShipment(reply: string, number: string): Record<string, unknown> {
  // The public Next.js route sends the shipment as an inline component prop.
  // Its module and row identifiers change independently of the shipment schema.
  let shipment: Record<string, unknown> | undefined;
  let notFound = false;
  for (const line of reply.split('\n')) {
    const row = /^[a-f0-9]+:(.*)$/.exec(line);
    if (!row) continue;
    const payload = row[1]!;
    if (payload === 'E{"digest":"NEXT_NOT_FOUND"}') notFound = true;
    if (!payload.startsWith('["$","$L')) continue;
    let component: unknown;
    try {
      component = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!Array.isArray(component) || !isRecord(component[3])) continue;
    const envelope = component[3].data;
    if (!isRecord(envelope) || !isRecord(envelope.data) || !Object.hasOwn(envelope.data, 'post_number')) continue;
    if (envelope.status !== true || envelope.data.post_number !== number || shipment) {
      throw new SchemaError(PROVIDER, 'Navlungo did not uniquely identify the requested parcel');
    }
    shipment = envelope.data;
  }

  if (!shipment && notFound) throw new NotFoundError(PROVIDER);
  if (!shipment || notFound) throw new SchemaError(PROVIDER);
  return shipment;
}

function scan(raw: unknown): CarrierEvent {
  if (!isRecord(raw) || typeof raw.status_code !== 'number' || !Number.isSafeInteger(raw.status_code)) {
    throw new SchemaError(PROVIDER, 'Navlungo returned an unreadable scan');
  }
  const description = clean(raw.action_result, 180);
  const stamp = clean(raw.created_at, 25);
  // These offsetless timestamps come from the portal's delivery history.
  // Validate their calendar fields without assigning a time zone.
  const localTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)
    ? isoTime(stamp.replace(' ', 'T'), 'UTC')?.iso.slice(0, 19)
    : undefined;
  if (!description || !localTime) throw new SchemaError(PROVIDER, 'Navlungo returned a scan without a status or timestamp');
  const code = String(raw.status_code);
  const stage = statusMap.stage(code, description);
  return {
    local_time: localTime, description, provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

export function parseNavlungo(reply: string, number: string): CarrierResult {
  const shipment = readShipment(reply, number);
  if (!isRecord(shipment.logs) || !Array.isArray(shipment.logs.post)
    || typeof shipment.post_status !== 'number' || !Number.isSafeInteger(shipment.post_status)) {
    throw new SchemaError(PROVIDER, 'Navlungo returned incomplete tracking history');
  }
  // The portal takes the latest same-second update last in its oldest-first history.
  const events = shipment.logs.post.map(scan).reverse()
    .sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  if (events.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const description = clean(shipment.post_status_name, 180) || events[0]!.description!;
  const stage = statusMap.stage(String(shipment.post_status), description);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: description,
    last_update: null,
    expected_delivery: null,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
