import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'rayspeed';
export const isBlocked = (text: string): boolean => /cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(text);

interface Reply {
  data?: unknown;
}

export function parseTracking(body: string, number: string): CarrierResult {
  let payload: Record<string, Reply | unknown[]>;
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch (cause) {
    if (isBlocked(body)) throw new ChallengeError(provider, 'RaySpeed requires verification', { cause });
    throw new SchemaError(provider, 'RaySpeed returned invalid JSON', { cause });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SchemaError(provider, 'Invalid RaySpeed reply');
  if (!Object.hasOwn(payload, number) || Object.keys(payload).length !== 1) {
    throw new IndeterminateError(provider, 'RaySpeed answered for another waybill');
  }
  const shipment = payload[number];
  if (Array.isArray(shipment) && !shipment.length) throw new NotFoundError(provider);
  if (Array.isArray(shipment) || !Array.isArray(shipment?.data)) throw new SchemaError(provider, 'Invalid RaySpeed shipment history');
  const history = shipment.data.map((row: { awb?: unknown; details?: unknown; date?: unknown } | null) => {
    if (typeof row?.awb !== 'string' || row.awb.trim().toUpperCase() !== number) throw new IndeterminateError(provider, 'RaySpeed history includes another waybill');
    const raw = typeof row.date === 'string' ? row.date.trim() : '';
    const withClock = raw.includes(' - ');
    const clock = DateTime.fromFormat(raw, withClock ? 'MMMM d, yyyy - H:mm' : 'MMMM d, yyyy', { zone: 'utc', locale: 'en-US' });
    const description = typeof row.details === 'string' ? row.details.trim() : '';
    if (!clock.isValid || !description) throw new SchemaError(provider, 'Invalid RaySpeed history row');
    const stage = stageForWording(normalizeStatusWording(description));
    const event: CarrierEvent = {
      description, local_time: withClock ? clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") : clock.toISODate(),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, stage };
  });
  const latest = history[0]?.event;
  if (!latest) throw new NoHistoryError(provider);
  const stage = history.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update_local: latest.local_time, events: history.map(scan => scan.event),
  };
}
