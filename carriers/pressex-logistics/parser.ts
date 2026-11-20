import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'pressex-logistics';
export const guideOperation = 'verBuscarListarGuia';
export const historyOperation = 'verBuscarListarStatusGuia';
export const tenant = 'pressex';

function publicObjects(response: unknown, operation: string): unknown[] {
  const data = isRecord(response) && isRecord(response.data) ? response.data[operation] : undefined;
  if (!isRecord(data) || !Array.isArray(data.objects)) {
    throw new SchemaError(provider, 'PressEx did not return the requested public tracking data');
  }
  return data.objects;
}

export function selectGuide(response: unknown, number: string) {
  const objects = publicObjects(response, guideOperation);
  if (!objects.length) throw new NotFoundError(provider);
  const matching = objects.filter(row => isRecord(row) && isRecord(row.agencia)
    && (row.agencia.sufijoUrl === tenant
      || (isRecord(row.agencia.agenciaPadre) && row.agencia.agenciaPadre.sufijoUrl === tenant))
    && row.activo === true && typeof row.numeroGuia === 'string'
    && row.numeroGuia.trim().toUpperCase() === number);
  if (matching.length !== 1) {
    throw new IndeterminateError(provider, 'PressEx did not identify one active guide for that number');
  }
  const guide = matching[0];
  if (!isRecord(guide) || typeof guide.id !== 'string' || !/^\d+$/.test(guide.id) || typeof guide.entregado !== 'boolean') {
    throw new SchemaError(provider, 'PressEx omitted the public guide identifier or delivery flag');
  }
  return { id: guide.id, delivered: guide.entregado };
}

function movementClock(value: unknown): { stamp: number; time: Pick<CarrierEvent, 'local_time' | 'time'> } | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || value.startsWith('0001-')) return;
  const clock = DateTime.fromISO(value, { zone: 'UTC', setZone: true });
  if (!clock.isValid) return;
  const time = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? { time: clock.toISO({ suppressMilliseconds: true }) }
    : { local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  return { stamp: clock.toMillis(), time };
}

export function parseHistory(response: unknown, delivered: boolean): CarrierResult {
  const updates = publicObjects(response, historyOperation).flatMap(row => {
    if (!isRecord(row) || row.activo !== true || !isRecord(row.status)
      || row.status.esVisiblePortalWebPublico !== true || typeof row.status.nombre !== 'string') return [];
    const description = clean(row.status.nombre);
    if (!description || hasPrivateDeliveryDetails(description)) return [];
    return [{
      description,
      stage: stages.get(description.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()),
      clock: movementClock(row.fechaHoraAlterna) ?? movementClock(row.fechaHoraInicial),
    }];
  }).sort((a, b) => (b.clock?.stamp ?? 0) - (a.clock?.stamp ?? 0));

  const events: CarrierEvent[] = updates.flatMap(({ clock, description, stage }) => clock
    ? [{ ...clock.time, description, ...(stage && { stage, stage_source: 'carrier_map' }) }] : []);
  const latest = delivered ? updates.find(row => row.stage === 'delivered') : updates[0];
  const stage: Stage | undefined = delivered ? 'delivered' : latest?.stage;
  if (!latest && !delivered) {
    throw new IndeterminateError(provider, 'PressEx listed the guide without a public status', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest?.description ?? 'ENTREGADO',
    ...(latest?.clock?.time.time && { last_update: latest.clock.time.time }),
    ...(latest?.clock?.time.local_time && { last_update_local: latest.clock.time.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}
