import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { stages } from './status.js';

export const provider = 'procon-express-lines';

type Movement = CarrierEvent & { local_time: string; description: string; stage: Stage };

function parseMovement(row: unknown): Movement | undefined {
  if (!Array.isArray(row)) return undefined;
  const [description, day, clock] = row as unknown[];
  if (typeof description !== 'string' || typeof day !== 'string' || !/^\d{8}$/.test(day)) return undefined;
  const stage = stages.get(description);
  if (!stage) return undefined;
  const hasClock = typeof clock === 'string' && /^\d{4}$/.test(clock);
  const time = DateTime.fromFormat(hasClock ? day + clock : day, hasClock ? 'yyyyMMddHHmm' : 'yyyyMMdd', { zone: 'UTC' });
  if (!time.isValid) return undefined;
  return {
    description, local_time: hasClock ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : time.toISODate(),
    stage, stage_source: 'carrier_map',
  };
}

export function parseTracking(body: string, reference: string): CarrierResult {
  if (!body.includes('Cargo Marketing Services Public Consignment Tracking')) {
    throw new SchemaError(provider, 'Procon Express Lines omitted its public consignment page');
  }
  if (body.includes('Consignment was not found using reference ' + reference)) throw new NotFoundError(provider);
  const returned = body.match(/"jobref":\["([A-Z0-9]+)"\]/)?.[1];
  if (!returned || returned !== reference) {
    throw new IndeterminateError(provider, 'Procon Express Lines did not return the requested consignment');
  }

  // The public Ext JS movement grid embeds JSON rows inside its store definition.
  const grid = body.match(/this\.children\.opsanlGrid=new aspicio\.widget\.GridPanel\([^]*?"data":(\[[^\r\n]*?\])\}\)/)?.[1];
  let rows: unknown;
  try {
    rows = grid && JSON.parse(grid);
  } catch {
    throw new SchemaError(provider, 'Procon Express Lines returned malformed movement rows');
  }
  if (!Array.isArray(rows)) throw new SchemaError(provider, 'Procon Express Lines omitted its movement grid');
  const distinct = new Map<string, Movement>();
  for (const row of rows as unknown[]) {
    const movement = parseMovement(row);
    if (movement) distinct.set(movement.local_time + '|' + movement.description, movement);
  }
  const events = [...distinct.values()].sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Procon Express Lines listed the consignment without dated movements', { reason: 'listed' });
  return {
    status: languageStageStatus(latest.stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
