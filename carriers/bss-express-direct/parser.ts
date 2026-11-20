import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bssStatus } from './status.js';

const carrier = 'bss-express-direct';

// The guest route sends a data-only Seroval object, explicit strings and an event array.
function fields(node: unknown): ReadonlyMap<string, unknown> {
  if (!isRecord(node) || node.t !== 10 || !isRecord(node.p)
    || !Array.isArray(node.p.k) || !Array.isArray(node.p.v)
    || node.p.k.length !== node.p.v.length || node.p.k.length > 64) {
    throw new SchemaError(carrier, 'BSS changed its tracking object');
  }
  const values: unknown[] = node.p.v;
  const result = new Map<string, unknown>();
  for (const [index, name] of (node.p.k as unknown[]).entries()) {
    if (typeof name !== 'string' || result.has(name)) throw new SchemaError(carrier, 'BSS returned invalid tracking fields');
    result.set(name, values[index]);
  }
  return result;
}

function stringValue(node: unknown): string {
  return isRecord(node) && node.t === 1 && typeof node.s === 'string' ? node.s : '';
}

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'BSS returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'BSS returned invalid tracking JSON');
  }
  const envelope = fields(reply);
  const error = envelope.get('error');
  if (!isRecord(error) || error.t !== 2 || error.s !== 1) {
    throw new IndeterminateError(carrier, 'BSS returned a tracking service error');
  }
  const result = envelope.get('result');
  if (isRecord(result) && result.t === 2 && result.s === 0) throw new NotFoundError(carrier);

  const shipment = fields(result);
  if (stringValue(shipment.get('id')) !== number) throw new IndeterminateError(carrier, 'BSS returned a different receipt');
  const code = clean(stringValue(shipment.get('status')), 80);
  const history = shipment.get('events');
  if (!code || !isRecord(history) || history.t !== 9 || !Array.isArray(history.a) || history.a.length > 500) {
    throw new SchemaError(carrier, 'BSS changed its tracking history');
  }

  const rows = (history.a as unknown[]).map(node => {
    const row = fields(node);
    const eventCode = clean(stringValue(row.get('status')), 80);
    const time = explicitOffsetTime(stringValue(row.get('at')));
    if (!eventCode || !time) throw new SchemaError(carrier, 'BSS returned an invalid event status or timestamp');
    const known = bssStatus(eventCode);
    const event: CarrierEvent = {
      description: known?.wording ?? eventCode, provider_code: eventCode, time: time.iso,
      ...(known?.stage && { stage: known.stage, stage_source: 'explicit_mapping' }),
    };
    return { event, timestamp: time.timestamp };
  }).reverse().sort((a, b) => b.timestamp - a.timestamp);
  const current = bssStatus(code);
  const stage = current?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current?.wording ?? code, provider_code: code,
    last_update: rows[0]?.event.time ?? null, expected_delivery: null,
    events: rows.slice(0, 100).map(row => row.event),
    ...(!rows.length && { summary_only: true }),
    ...(rows.length > 100 && { history_truncated: true }),
  };
}
