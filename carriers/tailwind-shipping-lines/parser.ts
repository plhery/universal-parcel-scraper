import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { movements } from './status.js';

export const provider = 'tailwind-shipping-lines';

type TimedEvent = CarrierEvent & { time: string; stage?: Stage };

function parseMovement(value: unknown): TimedEvent | undefined {
  if (!isRecord(value) || value.isEstimate !== false || typeof value.timestamp !== 'string'
    || typeof value.type !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,60}$/.test(value.type)
    || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.timestamp)) return undefined;

  const timestamp = DateTime.fromISO(value.timestamp, { setZone: true });
  if (!timestamp.isValid) return undefined;
  const mapped = movements.get(value.type);
  const location = isRecord(value.location) && typeof value.location.name === 'string'
    ? clean(value.location.name) : '';
  return {
    time: timestamp.toISO({ suppressMilliseconds: true }), provider_code: value.type,
    description: mapped?.description ?? value.type,
    ...(location && !hasPrivateDeliveryDetails(location) && { location }),
    ...(mapped && { stage: mapped.stage, stage_source: 'carrier_map' }),
  };
}

const newestFirst = (left: TimedEvent, right: TimedEvent): number => Date.parse(right.time) - Date.parse(left.time);

export function parseTracking(data: unknown, number: string): CarrierResult {
  if (!isRecord(data) || !Array.isArray(data.billOfLadings)) {
    throw new SchemaError(provider, 'Tailwind Shipping Lines did not return a booking record');
  }
  const bills = data.billOfLadings.filter(isRecord);
  const booking = data.bookingNumber === number;
  const equipment = /^[A-Z]{3}U\d{7}$/.test(number);
  const containers = bills.filter(bill => booking || equipment || bill.id === number)
    .flatMap(bill => Array.isArray(bill.containers) ? bill.containers.filter(isRecord) : [])
    .filter(container => !equipment || container.id === number);
  if (!containers.length) throw new IndeterminateError(provider, 'Tailwind Shipping Lines did not return the requested freight');

  const histories = containers.map(container => {
    if (!Array.isArray(container.milestones)) {
      throw new SchemaError(provider, 'Tailwind Shipping Lines omitted a container movement list');
    }
    return container.milestones.map(parseMovement).filter((event): event is TimedEvent => !!event).sort(newestFirst);
  });
  const distinct = new Map<string, TimedEvent>();
  for (const event of histories.flat()) {
    distinct.set(JSON.stringify([Date.parse(event.time), event.provider_code, event.location]), event);
  }
  const events = [...distinct.values()].sort(newestFirst);
  const latest = events[0];
  if (!latest) {
    throw new IndeterminateError(provider, 'Tailwind Shipping Lines listed the freight without completed movements', { reason: 'listed' });
  }
  const stage = histories.every(history => history[0]?.stage === latest.stage) ? latest.stage : undefined;
  const sameStatus = histories.every(history => history[0]?.provider_code === latest.provider_code);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(sameStatus && { last_status_text: latest.description }),
    last_update: latest.time, events,
  };
}
