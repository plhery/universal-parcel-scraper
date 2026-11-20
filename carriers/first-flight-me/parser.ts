import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { stageForScan } from './status.js';

export const PROVIDER = 'First Flight (Middle East)';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a First Flight air waybill');
  return number;
}

function scanClock(date: string, time: string): string | null {
  const value = `${date}, ${time}`;
  // UTC checks the calendar. The service displays a date and a clock without an offset.
  const formats = ['yyyy-MM-dd, HH:mm:ss', 'yyyy-MM-dd, HH:mm', 'cccc, MMMM dd, yyyy, HH:mm', 'dd MMM yyyy, HH:mm'];
  for (const format of formats) {
    const parsed = zonedTime(value, format, 'UTC', { locale: 'en' });
    if (parsed) return parsed.iso.slice(0, 19);
  }
  return null;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'First Flight returned a browser check');
  }
  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(PROVIDER, 'First Flight returned invalid tracking JSON'); }
  if (!isRecord(reply) || reply.Code !== 1 || !Array.isArray(reply.AirwayBillTrackList)) {
    throw new SchemaError(PROVIDER, 'First Flight returned no waybill results');
  }
  if (!reply.AirwayBillTrackList.length) throw new NotFoundError(PROVIDER);
  const waybill: unknown = reply.AirwayBillTrackList[0];
  if (reply.AirwayBillTrackList.length !== 1 || !isRecord(waybill)
    || typeof waybill.AirWayBillNo !== 'string' || waybill.AirWayBillNo.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'First Flight did not identify the requested waybill');
  }
  if (waybill.TrackingLogDetails === null && waybill.Origin === null && waybill.Destination === null
    && waybill.ShipperReference === null && waybill.ShipmentProgress === 0) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(waybill.TrackingLogDetails)) throw new SchemaError(PROVIDER, 'First Flight returned no recognized history field');
  const events: CarrierEvent[] = (waybill.TrackingLogDetails as unknown[]).map(scan => {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'First Flight returned an invalid scan');
    const code = clean(scan.Status, 32);
    const location = clean(scan.Location, 120);
    const wording = clean(scan.Remarks, 500);
    const description = wording || (code === 'POD' ? 'Delivered' : code === 'RTO' ? 'Returned' : code);
    const local_time = scanClock(clean(scan.ActivityDate, 64), clean(scan.ActivityTime, 24));
    if (!local_time || !description) throw new SchemaError(PROVIDER, 'First Flight returned an incomplete scan');
    const stage = stageForScan(code, description);
    return { local_time, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
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
