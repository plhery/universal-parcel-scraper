import { DateTime } from 'luxon';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { stageForCode } from './status.js';

export const provider = 'jas-worldwide';

interface Reference {
  houseBill: string;
  shipmentRef: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new SchemaError(provider, 'Malformed MyJAS component row', { cause });
  }
}

export function parseReference(body: string, number: string): Reference {
  const rows = body.split('\n').filter(line => /^[0-9a-f]+:\["\$","\$L[0-9a-f]+",null,\{"initialData":/.test(line));
  if (rows.length !== 1) throw new SchemaError(provider, 'Missing MyJAS search results');
  const component = json(rows[0]!.slice(rows[0]!.indexOf(':') + 1));
  const props = record(Array.isArray(component) ? component[3] : undefined);
  const grid = record(props?.initialData);
  if (props?.initialError !== '$undefined' || !Array.isArray(grid?.data) ||
    typeof grid.total !== 'number' || !Number.isSafeInteger(grid.total) || grid.total < grid.data.length) {
    throw new SchemaError(provider, 'Invalid MyJAS search results');
  }
  if (grid.total === 0) throw new NotFoundError(provider);
  const matches = grid.data.map(record).filter(row =>
    row?.houseBill === number || row?.shipmentRef === number,
  );
  const match = matches[0];
  if (matches.length !== 1 || grid.total > grid.data.length || !match ||
    typeof match.houseBill !== 'string' || typeof match.shipmentRef !== 'string' ||
    !/^[A-Z0-9][A-Z0-9-]{2,39}$/i.test(match.shipmentRef)) {
    throw new IndeterminateError(provider, 'MyJAS could not identify one whole shipment reference');
  }
  return { houseBill: match.houseBill, shipmentRef: match.shipmentRef };
}

function actionResult(body: string): Record<string, unknown> | undefined {
  const rows = body.split('\n');
  const root = record(json(rows[0]?.startsWith('0:') ? rows[0].slice(2) : '{}'));
  const pointer = typeof root?.a === 'string' ? /^\$@([0-9a-f]+)$/.exec(root.a) : null;
  const prefix = pointer ? `${pointer[1]}:` : '';
  const result = prefix ? rows.find(line => line.startsWith(prefix)) : undefined;
  return result?.startsWith(`${prefix}{`) ? record(json(result.slice(prefix.length))) : undefined;
}

export function parseDetails(body: string, reference: Reference): CarrierResult {
  const reply = actionResult(body);
  if (!reply || !Array.isArray(reply.milestonesNew)) throw new SchemaError(provider, 'Missing MyJAS shipment details');
  if (reply.shipmentNumber !== reference.shipmentRef || reply.houseBill !== reference.houseBill) {
    throw new IndeterminateError(provider, 'MyJAS answered for another shipment');
  }
  const events = new Map<string, { event: CarrierEvent; stage: ReturnType<typeof stageForCode>; sort: number }>();
  for (const value of reply.milestonesNew) {
    const row = record(value);
    if (!row || typeof row.isCompleted !== 'boolean') throw new SchemaError(provider, 'Invalid MyJAS milestone');
    if (!row.isCompleted || row.actualDate === null) continue;
    const { actualDate, description, eventCode } = row;
    if (typeof description !== 'string' || !description.trim() || typeof eventCode !== 'string' ||
      typeof actualDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(actualDate)) {
      throw new SchemaError(provider, 'Invalid completed MyJAS milestone');
    }
    const instant = explicitOffsetTime(actualDate);
    const clock = DateTime.fromISO(actualDate, { zone: 'utc', setZone: true });
    if (!clock.isValid) throw new SchemaError(provider, 'Invalid MyJAS milestone time');
    const stage = stageForCode(eventCode);
    const event: CarrierEvent = {
      description, provider_code: eventCode,
      ...(instant ? { time: instant.iso } : { local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    events.set(JSON.stringify([actualDate, description, eventCode]), { event, stage, sort: clock.toMillis() });
  }
  const history = [...events.values()].sort((a, b) => b.sort - a.sort || Number(b.stage === 'delivered') - Number(a.stage === 'delivered'));
  const newest = history[0]?.event;
  if (!newest) throw new NoHistoryError(provider);
  // A house bill's delivery is conclusive even when its containers were delivered at the same time.
  const stage = history.find(row => row.stage === 'delivered')?.stage ?? history.find(row => row.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    ...(newest.time ? { last_update: newest.time } : { last_update_local: newest.local_time }),
    events: history.map(row => row.event),
  };
}
