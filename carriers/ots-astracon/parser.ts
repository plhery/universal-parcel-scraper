import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'O.T.S. ASTRACON';

export function astraconNumber(input: string): string {
  const number = input.trim().toUpperCase().replace(/^ASQR\s*(SE\d{9})$/, '$1');
  if (!/^[A-Z0-9][A-Z0-9-]{5,31}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Enter an O.T.S. ASTRACON house bill, shipment ID or container number');
  }
  return number;
}

export function parseAstracon(payload: unknown, number: string): CarrierResult {
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER);
  if (!payload.length) throw new NotFoundError(PROVIDER);

  const records: readonly unknown[] = payload;
  const matches = records.filter(item => {
    if (!isRecord(item) || !isRecord(item.data)) return false;
    const { HOUSEBILLNUMBER: house, SHIPMENTID: shipment, CONTAINERNUMBER: container } = item.data;
    if (item.entityType === 'IJobShipment') return house === number || shipment === number;
    return item.entityType === 'IJobContainer' && container === number;
  });
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'Expected one exact O.T.S. ASTRACON tracking result');

  const shipment = matches[0];
  if (!isRecord(shipment) || !Array.isArray(shipment.events)) throw new SchemaError(PROVIDER, 'Missing O.T.S. ASTRACON history');

  const history: readonly unknown[] = shipment.events;
  const scans = [];
  for (const event of history) {
    if (!isRecord(event) || typeof event.isEstimate !== 'boolean') throw new SchemaError(PROVIDER);
    if (event.isEstimate) continue;
    const clock = explicitOffsetTime(event.eventTimeUtc);
    const description = clean(event.eventDescription, 160);
    if (!clock || !description) throw new SchemaError(PROVIDER, 'Incomplete O.T.S. ASTRACON tracking event');
    scans.push({ clock, description });
  }
  scans.sort((a, b) => b.clock.timestamp - a.clock.timestamp);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { clock, description } of scans) {
    const key = clock.timestamp + '\0' + description;
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = statusMap.stage(null, normalizeStatusWording(description));
    events.push({ time: clock.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: lead?.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
