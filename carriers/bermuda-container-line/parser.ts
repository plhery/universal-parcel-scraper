import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'bermuda-container-line';

type Movement = CarrierEvent & { stage?: Stage; local_time: string; description: string };

function wording(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = clean(value);
  return hasPrivateDeliveryDetails(normalized) ? '' : normalized;
}

function movement(value: unknown): Movement | undefined {
  if (!isRecord(value)) return;
  const description = wording(value.type);
  const date = wording(value.date);
  const time = wording(value.time).toUpperCase();
  if (!description || !date) return;
  const clock = DateTime.fromFormat(time ? date + ' ' + time : date, time ? 'd MMMM yyyy h:mm a' : 'd MMMM yyyy', {
    zone: 'UTC', locale: 'en',
  });
  if (!clock.isValid) return;
  const localTime = time ? clock.toFormat("yyyy-MM-dd'T'HH:mm") : clock.toISODate();
  const location = [wording(value.location), wording(value.locationType)].filter(Boolean).join(', ');
  const stage = stages.get(description);
  return {
    local_time: localTime, description,
    ...(location && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseTracking(data: unknown, number: string): CarrierResult {
  if (!isRecord(data) || wording(data.query).toUpperCase() !== number
    || !Array.isArray(data.groups) || typeof data.resultCount !== 'number') {
    throw new SchemaError(provider, 'Bermuda Container Line did not return a matching tracking response');
  }
  if (data.resultCount === 0 && data.groups.length === 0) throw new NotFoundError(provider);

  const byContainer = new Map<string, Movement[]>();
  for (const group of data.groups) {
    if (!isRecord(group) || !Array.isArray(group.containers)) continue;
    const byBooking = wording(group.documentCode).toUpperCase() === number;
    for (const container of group.containers as unknown[]) {
      if (!isRecord(container) || typeof container.containerNumber !== 'string' || !Array.isArray(container.moves)) continue;
      const equipment = wording(container.containerNumber).toUpperCase();
      if (!equipment || (!byBooking && equipment !== number)) continue;

      const events = (container.moves as unknown[]).flatMap(row => {
        const event = movement(row);
        return event ? [event] : [];
      });
      const history = byContainer.get(equipment) ?? [];
      history.push(...events);
      byContainer.set(equipment, history);
    }
  }
  if (!byContainer.size) {
    throw new IndeterminateError(provider, 'Bermuda Container Line did not identify the requested booking or container');
  }

  const timelines = [...byContainer.values()].map(events =>
    events.sort((a, b) => b.local_time.localeCompare(a.local_time)));
  const events = [...new Map(timelines.flat().map(event => [JSON.stringify(event), event])).values()]
    .sort((a, b) => b.local_time.localeCompare(a.local_time));
  const latest = events[0];
  if (!latest) {
    throw new IndeterminateError(provider, 'Bermuda Container Line listed the shipment without dated movements', { reason: 'listed' });
  }
  const stage = timelines.every(history => history[0]?.stage === latest.stage) ? latest.stage : undefined;
  const description = timelines.every(history => history[0]?.description === latest.description)
    ? latest.description : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(description && { last_status_text: description, last_update_local: latest.local_time }),
    events,
  };
}
