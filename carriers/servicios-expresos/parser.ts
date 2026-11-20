import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'servicios-expresos';

const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function localTime(value: unknown): string | undefined {
  const raw = clean(value);
  if (!datePattern.test(raw)) return undefined;
  const date = DateTime.fromSQL(raw, { zone: 'utc' });
  return date.isValid ? date.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Servicios Expresos did not return tracking JSON');
  }
  if (!isRecord(reply) || !Array.isArray(reply.data)) {
    throw new SchemaError(provider, 'Servicios Expresos omitted the shipment movements');
  }
  if (reply.result !== true || !isRecord(reply.dataEnvio) || clean(reply.dataEnvio.Guia).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Servicios Expresos did not confirm the requested guide');
  }
  if (!Array.isArray(reply.EstatusDisponible)) throw new SchemaError(provider, 'Servicios Expresos omitted its status labels');

  const labels = new Map<string, string>();
  for (const entry of reply.EstatusDisponible as unknown[]) {
    if (!isRecord(entry)) continue;
    const level = cleanScalar(entry.ENRUES_NIVEL);
    const description = clean(entry.ENRUES_NOMBRE);
    if (level && description && !hasPrivateDeliveryDetails(description)) labels.set(level, description);
  }
  const events: (CarrierEvent & { stage?: Stage })[] = [];
  let current: (CarrierEvent & { stage?: Stage }) | undefined;
  let highest = -1;
  for (const entry of reply.data as unknown[]) {
    if (!isRecord(entry)) continue;
    const code = cleanScalar(entry.Nivel);
    if (!/^\d{1,4}$/.test(code)) continue;
    const description = labels.get(code);
    const local = localTime(entry.Fecha);
    if (!description || !local) continue;
    const stage = stages.get(description.toUpperCase());
    const event = {
      description, local_time: local, provider_code: code,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
    events.push(event);
    if (+code > highest || (+code === highest && local > (current?.local_time ?? ''))) {
      current = event;
      highest = +code;
    }
  }
  if (!current) throw new IndeterminateError(provider, 'Servicios Expresos listed the guide without dated tracking movements', { reason: 'listed' });
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  return {
    status: current.stage ? languageStageStatus(current.stage) : 'unknown',
    ...(current.stage && { current_stage: current.stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description, last_update_local: current.local_time, events,
  };
}
