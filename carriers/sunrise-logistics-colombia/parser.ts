import { DateTime } from 'luxon';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'sunrise-logistics-colombia';
type Entry = { description: string; stage?: Stage; current: boolean; movement?: CarrierEvent; sortTime: number };

function textOf(value: unknown): string {
  return typeof value === 'string' ? clean(value) : '';
}

function clockOf(value: unknown) {
  const text = textOf(value);
  if (text.startsWith('0001-') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return undefined;
  const stamp = DateTime.fromISO(text, { setZone: true, zone: 'UTC' });
  if (!stamp.isValid) return undefined;
  const time = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
    ? { time: stamp.toISO({ suppressMilliseconds: true }) }
    : { local_time: stamp.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  return { time, sortTime: stamp.toMillis() };
}

export function parseTracking(items: unknown[], number: string): CarrierResult {
  const entries: Entry[] = [];
  for (const row of items) {
    if (!isRecord(row) || textOf(row.numeroDocumento).toUpperCase() !== number) continue;
    const description = textOf(row.nombreEstadoSeguimiento) || textOf(row.nombreEstado);
    if (!description || hasPrivateDeliveryDetails(description)) continue;

    const stage = stages.get(description.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase());
    const clock = clockOf(row.fechaSeguimiento);
    const written = clockOf(row.fechaInsercion);
    const movement = clock && {
      ...clock.time, description,
      ...(written?.time.time && { written_at: written.time.time }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
    entries.push({
      description, stage, current: row.vigente === true, movement,
      sortTime: clock?.sortTime ?? written?.sortTime ?? Number.NEGATIVE_INFINITY,
    });
  }

  entries.sort((a, b) => b.sortTime - a.sortTime);
  const current = entries.find(entry => entry.current);
  const summary = current ?? entries[0];
  if (!summary) {
    throw new IndeterminateError(provider, 'Sunrise Logistics did not return a status for the requested air waybill');
  }
  const stage = current?.stage;
  const history = entries.flatMap(entry => entry.movement ? [entry.movement] : []);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary.description,
    ...(summary.movement?.time && { last_update: summary.movement.time }),
    ...(summary.movement?.local_time && { last_update_local: summary.movement.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
