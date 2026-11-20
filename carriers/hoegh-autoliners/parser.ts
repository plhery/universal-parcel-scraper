import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'hoegh-autoliners';

function localDate(value: unknown): string | undefined {
  const date = DateTime.fromISO(clean(value), { setZone: true });
  return date.isValid && date.year >= 1950 ? date.toISODate() : undefined;
}

export function parseTracking(body: string, bill: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Höegh Autoliners requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Höegh Autoliners did not return cargo JSON');
  }
  if (!Array.isArray(reply)) throw new SchemaError(provider, 'Höegh Autoliners omitted the cargo list');
  const rows: unknown[] = reply;
  if (!rows.length) throw new NotFoundError(provider);

  const events = new Map<string, CarrierEvent>();
  const statuses = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.bol_number !== 'string') {
      throw new SchemaError(provider, 'Höegh Autoliners returned an invalid cargo item');
    }
    if (clean(row.bol_number) !== bill) throw new IndeterminateError(provider, 'Höegh Autoliners returned a different bill');
    statuses.add(clean(row.status_code));
    if (!Array.isArray(row.routes)) continue;
    for (const route of row.routes as unknown[]) {
      if (!isRecord(route)) continue;
      const location = /^[A-Z]{2}[A-Z0-9]{3}$/.test(clean(route.portLoad)) ? clean(route.portNameLoad) : '';
      const milestones = [
        { description: 'Loaded', date: route.loadDate },
        { description: 'Received', date: route.recievedDate },
      ];
      for (const { description, date } of milestones) {
        const day = localDate(date);
        if (!day) continue;
        const stage = scanStages.get(description);
        events.set(JSON.stringify([day, description, location]), {
          description, local_time: day,
          ...(location && !hasPrivateDeliveryDetails(location) && { location }),
          ...(stage && { stage, stage_source: 'carrier_map' }),
        });
      }
    }
  }
  const history = [...events.values()].sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const label = statuses.size === 1 ? [...statuses][0] : 'Mixed cargo statuses';
  const stage = label ? scanStages.get(label) : undefined;
  if (!label && !history.length) {
    throw new IndeterminateError(provider, 'Höegh Autoliners listed cargo without a status or dated movements', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(label && !hasPrivateDeliveryDetails(label) && { last_status_text: label }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
