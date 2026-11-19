import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { stageOf } from './status.js';

const provider = 'velocity-express-in';

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(provider, 'Invalid tracking JSON'); }
  if (httpStatus === 404 && isRecord(reply) && reply.error === 'No tracking data found' && reply.awb === number) {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !Array.isArray(reply) || reply.length !== 1) throw new SchemaError(provider, 'Unexpected tracking reply');
  const result: unknown = reply[0];
  if (!isRecord(result) || result.Error !== null || !Array.isArray(result.Parent) || !Array.isArray(result.Child)) {
    throw new SchemaError(provider, 'Invalid shipment record');
  }
  const shipment: unknown = result.Parent[0];
  if (result.Parent.length !== 1 || !isRecord(shipment) || shipment.AirwayBill !== number) {
    throw new IndeterminateError(provider, 'Velocity Express answered for another airway bill');
  }

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of result.Child as unknown[]) {
    if (!isRecord(row) || row.awbno !== number) throw new IndeterminateError(provider, 'Airway bill mismatch in history');
    const { Remarks, Statuscode, Statusdate, Statustime, LocationCity } = row;
    if (typeof Remarks !== 'string' || !Remarks.trim() || typeof Statuscode !== 'string' || !Statuscode.trim()
        || typeof Statusdate !== 'string' || typeof Statustime !== 'string') {
      throw new SchemaError(provider, 'Invalid history row');
    }
    const clock = DateTime.fromFormat(`${Statusdate} ${Statustime}`, 'dd-MMM-yyyy HH:mm:ss', { locale: 'en', zone: 'utc' });
    if (!clock.isValid) throw new SchemaError(provider, 'Invalid scan clock');
    const local_time = clock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const location = typeof LocationCity === 'string' ? LocationCity.trim() : '';
    const key = JSON.stringify([local_time, Statuscode, Remarks, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = stageOf(Statuscode);
    events.push({ local_time, description: Remarks, provider_code: Statuscode, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }

  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const newest = events[0];
  if (!newest) throw new IndeterminateError(provider, 'Velocity Express returned no history');
  const stage = stageOf(newest.provider_code!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!, last_update_local: newest.local_time!, events,
  };
}
