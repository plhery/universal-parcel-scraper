import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForScan } from './status.js';

export const PROVIDER = 'Diakinisis';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,50}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Diakinisis order or voucher number');
  return number;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Diakinisis returned a browser check');
  }
  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(PROVIDER, 'Diakinisis returned invalid tracking JSON'); }
  if (!Array.isArray(reply) || reply.length !== 3) throw new SchemaError(PROVIDER, 'Diakinisis tracking envelope changed');
  const [status, message, record] = reply as [unknown, unknown, unknown];
  if (status === '0' && message === 'Δεν βρέθηκε κάμια Παραγγελία.' && Array.isArray(record) && !record.length) {
    throw new NotFoundError(PROVIDER);
  }
  if (status !== '1' || !isRecord(record) || !isRecord(record.order) || !Array.isArray(record.history)) {
    throw new SchemaError(PROVIDER, 'Diakinisis returned no shipment data');
  }
  if (typeof record.order.order_id !== 'string' || record.order.order_id.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Diakinisis did not identify the requested shipment');
  }

  const events: CarrierEvent[] = (record.history as unknown[]).map((event) => {
    if (!isRecord(event) || typeof event.action_date !== 'string' || typeof event.action_time !== 'string') {
      throw new SchemaError(PROVIDER, 'Diakinisis returned a scan without its clock');
    }
    const date = zonedTime(event.action_date + ' ' + event.action_time, 'dd/MM/yyyy HH:mm:ss', 'UTC');
    const description = typeof event.action === 'string' ? clean(event.action, 500) : '';
    if (!date || !description) throw new SchemaError(PROVIDER, 'Diakinisis returned an incomplete scan');
    const stage = stageForScan(description);
    return { local_time: date.iso.slice(0, 19), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).reverse();
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
