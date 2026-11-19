import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { DateTime } from 'luxon';
import { scanStage } from './status.js';

const provider = 'usea-express';

export function parseTracking(text: string, number: string, httpStatus: number): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(text); }
  catch { throw new SchemaError(provider, 'Tracking service returned invalid JSON'); }
  if (httpStatus !== 200 || !isRecord(reply)) throw new SchemaError(provider, 'Invalid tracking reply');
  if (reply.code === 502 && reply.data === `未找到打印单【${number}】`) throw new NotFoundError(provider);
  if (reply.code !== 200 || !Array.isArray(reply.data) || reply.data.length !== 1) throw new SchemaError(provider, 'Unexpected shipment list');
  const shipment: unknown = reply.data[0];
  if (!isRecord(shipment) || shipment.expressNo !== number) throw new IndeterminateError(provider, 'Shipment identity mismatch');
  if (!Array.isArray(shipment.events)) throw new SchemaError(provider, 'Missing events');
  const events = shipment.events.map((row: unknown) => {
    if (!isRecord(row) || typeof row.content !== 'string' || !row.content.trim() || typeof row.time !== 'string') throw new SchemaError(provider, 'Invalid event');
    const description = row.content;
    const clock = DateTime.fromFormat(row.time, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!clock.isValid) throw new SchemaError(provider, 'Invalid scan time');
    const stage = scanStage(description);
    return { description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"), ...(typeof row.location === 'string' && row.location ? { location: row.location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  });
  if (!events.length) throw new NoHistoryError(provider);
  const newest = events[0]!;
  const stage = scanStage(newest.description);
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    events,
  };
}
