import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { paquetExStage } from './status.js';

const carrier = 'paquetex';
const BOX_NUMBER = /^\d{1,16}$/;
const FULL_REFERENCE = /^(?:MEX|GUA|SLV|HON|NIC)\d{1,16}$/;
const INVALID_REFERENCE = 'Formato inválido. Use un número de orden (ej: 46086, MEX046086) o tracking FedEx';
export const REFERENCE = /^(?:MEX|GUA|SLV|HON|NIC)?\d{1,16}$/;

function statusCode(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new SchemaError(carrier, 'PaquetEx returned an invalid status code');
}

export function parseTracking(text: string, number: string, httpStatus: number): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'PaquetEx returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'PaquetEx returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'PaquetEx changed its tracking response');
  if (httpStatus === 400 && reply.found === false && reply.error === INVALID_REFERENCE) {
    throw new InvalidInputError(carrier, 'PaquetEx did not accept the box reference');
  }
  if (reply.found === false || reply.source === 'fedex') {
    throw new IndeterminateError(carrier, 'PaquetEx returned no matching box record');
  }

  const order = reply.order;
  if (httpStatus !== 200 || reply.found !== true || !isRecord(order) || !isRecord(order.status)
    || !Array.isArray(order.timeline) || order.timeline.length > 500
    || typeof order.id !== 'number' || !Number.isSafeInteger(order.id) || order.id <= 0) {
    throw new SchemaError(carrier, 'PaquetEx changed its box record');
  }
  const canonical = clean(order.tracking_number, 64);
  if (!FULL_REFERENCE.test(canonical)) throw new SchemaError(carrier, 'PaquetEx omitted the full box reference');
  // The guest API may return the box even if the supplied country prefix is different.
  if (BOX_NUMBER.test(number) ? number.replace(/^0+(?=\d)/, '') !== String(order.id) : number !== canonical) {
    throw new IndeterminateError(carrier, 'PaquetEx returned a different box reference');
  }
  const code = statusCode(order.status.id);
  const statusText = clean(order.status.name, 150);
  if (!statusText) throw new SchemaError(carrier, 'PaquetEx omitted the box status');

  const scans = order.timeline.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(carrier, 'PaquetEx changed its box timeline');
    const time = explicitOffsetTime(row.datetime);
    const description = clean(row.status_name, 150);
    const rowCode = statusCode(row.status_id);
    if (!time || !description) throw new SchemaError(carrier, 'PaquetEx changed its scan fields');
    const stage = paquetExStage(rowCode);
    const event: CarrierEvent = {
      time: time.iso, description, provider_code: rowCode, ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
    return { event, timestamp: time.timestamp };
  }).sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.slice(0, 100).map(scan => scan.event);
  const stage = paquetExStage(code);
  const destination = isRecord(order.destination) ? clean(order.destination.country, 80) : '';
  const service = clean(order.service_type, 80);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: statusText, provider_code: code, last_update: events[0]?.time ?? null,
    expected_delivery: null, events, canonical_tracking_number: canonical,
    ...(destination && { destination_country_name: destination }),
    ...(service && { service_name: service }),
    ...(!events.length && { summary_only: true }),
    ...(scans.length > 100 && { history_truncated: true }),
  };
}
