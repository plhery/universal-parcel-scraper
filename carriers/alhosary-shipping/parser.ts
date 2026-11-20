import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { alhosaryStatus } from './status.js';

const carrier = 'alhosary-shipping';

// Read only the data nodes used by the public tracker. No references, executable nodes,
// or serializer extensions are needed to interpret an ordinary lookup.
function properties(node: unknown): ReadonlyMap<string, unknown> {
  if (!isRecord(node) || node.t !== 10 || !isRecord(node.p)
    || !Array.isArray(node.p.k) || !Array.isArray(node.p.v)
    || node.p.k.length !== node.p.v.length || node.p.k.length > 100) {
    throw new SchemaError(carrier, 'Alhosary changed its tracking object');
  }
  const fields = new Map<string, unknown>();
  const keys: unknown[] = node.p.k;
  const values: unknown[] = node.p.v;
  for (const [index, key] of keys.entries()) {
    if (typeof key !== 'string' || fields.has(key)) throw new SchemaError(carrier, 'Alhosary returned invalid tracking fields');
    fields.set(key, values[index]);
  }
  return fields;
}

function string(node: unknown): string {
  return isRecord(node) && node.t === 1 && typeof node.s === 'string' ? node.s : '';
}

function constant(node: unknown, value: number): boolean {
  return isRecord(node) && node.t === 2 && node.s === value;
}

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Alhosary returned a browser check');
  }

  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Alhosary returned invalid tracking JSON');
  }
  const envelope = properties(reply);
  if (!constant(envelope.get('error'), 1)) throw new SchemaError(carrier, 'Alhosary returned a tracking service error');
  const result = properties(envelope.get('result'));
  const shipment = result.get('shipment');
  const history = result.get('events');
  if (!isRecord(history) || history.t !== 9 || !Array.isArray(history.a) || history.a.length > 100) {
    throw new SchemaError(carrier, 'Alhosary changed its event history');
  }
  if (constant(result.get('found'), 3) && constant(shipment, 0) && history.a.length === 0) throw new NotFoundError(carrier);
  if (!constant(result.get('found'), 2)) throw new SchemaError(carrier, 'Alhosary returned an inconsistent lookup result');

  const fields = properties(shipment);
  if (string(fields.get('tracking_number')) !== number) {
    throw new IndeterminateError(carrier, 'Alhosary returned a different shipment number');
  }
  const code = clean(string(fields.get('status')), 80);
  if (!code) throw new SchemaError(carrier, 'Alhosary omitted the current shipment status');
  const current = alhosaryStatus(code);
  const rows = (history.a as unknown[]).map((node) => {
    const row = properties(node);
    const rowCode = clean(string(row.get('status')), 80);
    const time = explicitOffsetTime(string(row.get('event_time')));
    if (!time || !rowCode) throw new SchemaError(carrier, 'Alhosary returned an invalid event status or time');
    const location = clean(string(row.get('location')), 150);
    const status = alhosaryStatus(rowCode);
    const event: CarrierEvent = {
      time: time.iso, description: status?.wording ?? rowCode, provider_code: rowCode,
      ...(status && { stage: status.stage, stage_source: 'explicit_mapping' }),
      ...(location && { location }),
    };
    return { event, timestamp: time.timestamp };
  });
  rows.reverse().sort((a, b) => b.timestamp - a.timestamp);
  const events = rows.map(({ event }) => event);
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current && { current_stage: current.stage, current_stage_source: 'explicit_mapping' }),
    provider_code: code, last_status_text: current?.wording ?? code,
    last_update: events[0]?.time ?? null, expected_delivery: null, events,
    ...(!events.length && { summary_only: true }),
  };
}
