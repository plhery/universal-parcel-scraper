import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { PROVIDER } from './number.js';
import { stageForScan } from './status.js';

export { normalizeNumber, PROVIDER } from './number.js';

interface DatedScan {
  event: CarrierEvent;
  at: number;
}

function parseScan(value: unknown): DatedScan {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Sway returned an invalid scan');
  const timestamp = explicitOffsetTime(value.timestamp);
  const code = typeof value.state === 'string' && /^[A-Z_]{1,40}$/.test(value.state) ? value.state : '';
  const description = typeof value.details === 'string' ? clean(value.details, 500) || code : code;
  if (!timestamp || !description || !code) throw new SchemaError(PROVIDER, 'Sway returned an incomplete scan');
  const stage = stageForScan(code);
  const event: CarrierEvent = { time: timestamp.iso, provider_code: code, description,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  return { event, at: timestamp.timestamp };
}

export function parseTracking(httpStatus: number, body: string, number: string): CarrierResult {
  if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Sway returned a browser check');
  }
  if (httpStatus === 404 && body.trim() === 'null') throw new NotFoundError(PROVIDER);
  if (httpStatus === 404 || httpStatus === 410) {
    throw new TransportError(PROVIDER, 'Sway tracking endpoint is unavailable', { status: httpStatus });
  }

  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(PROVIDER, 'Sway returned invalid tracking JSON'); }
  if (!isRecord(reply) || typeof reply.trackingNumber !== 'string' || reply.trackingNumber !== number) {
    throw new SchemaError(PROVIDER, 'Sway did not identify the requested shipment');
  }
  if (typeof reply.destinationCountry === 'string' && reply.destinationCountry !== '' && reply.destinationCountry !== 'US') {
    throw new InvalidInputError(PROVIDER, 'This Sway adapter covers U.S. deliveries');
  }
  if (reply.trackingHistory != null && !Array.isArray(reply.trackingHistory)) {
    throw new SchemaError(PROVIDER, 'Sway returned an invalid tracking history');
  }

  // The tracker lists its oldest scan first. Reverse before sorting to preserve the order of ties.
  const scans = (Array.isArray(reply.trackingHistory) ? (reply.trackingHistory as unknown[]).map(parseScan) : [])
    .reverse().sort((a, b) => b.at - a.at);
  const summary = reply.currentStatus == null ? undefined : parseScan(reply.currentStatus);
  const newest = scans[0];
  const current = summary && (!newest || summary.at >= newest.at) ? summary : newest;
  if (!current) throw new NoHistoryError(PROVIDER);
  const stage = current.event.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current.event.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: current.event.provider_code,
    last_status_text: current.event.description,
    last_update: current.event.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(!scans.length ? { summary_only: true } : {}),
    events: scans.map(scan => scan.event),
  };
}
