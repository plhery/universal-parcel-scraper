import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { stageForCode } from './status.js';

export const provider = 'transdirect';

function parseScan(row: unknown) {
  if (!isRecord(row)) throw new SchemaError(provider, 'Invalid Transdirect scan');
  const code = clean(row.stage);
  const stage = stageForCode(code);
  const detail = clean(row.description);
  const status = clean(row.status);
  const description = detail && !/^[A-Z]{2,4}$/.test(detail) && !hasPrivateDeliveryDetails(detail)
    ? detail
    : status;
  const clock = explicitOffsetTime(row.occurredAt);
  if (row.occurredAt != null && !clock) throw new SchemaError(provider, 'Invalid Transdirect scan timestamp');
  if (!description && !stage) throw new SchemaError(provider, 'Transdirect scan has no status');
  const location = clean(row.location);
  const event: CarrierEvent = {
    ...(description ? { description } : {}),
    ...(clock ? { time: clock.iso } : {}),
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
  return { event, stage, timestamp: clock?.timestamp ?? -Infinity };
}

export function parseTracking(body: unknown, reference: string, httpStatus: number): CarrierResult {
  if (!isRecord(body) || typeof body.reference !== 'string' || !Array.isArray(body.items)) {
    throw new SchemaError(provider, 'Invalid Transdirect tracking reply');
  }
  if (body.reference !== reference) throw new IndeterminateError(provider, 'Transdirect replied to another reference');
  if (httpStatus === 404 && body.matched === false && body.state === 'not_found' && body.items.length === 0) {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || body.matched !== true || typeof body.state !== 'string') {
    throw new SchemaError(provider, 'Invalid Transdirect tracking status');
  }

  const wholeShipment = reference === cleanScalar(body.bookingId) || reference === clean(body.connote);
  const items = body.items.map((item: unknown) => {
    if (!isRecord(item) || !Array.isArray(item.events)) throw new SchemaError(provider, 'Invalid Transdirect item history');
    return { label: clean(item.label), stage: clean(item.stage), events: item.events as unknown[] };
  });
  const selected = wholeShipment ? items : items.filter(item => reference === item.label);
  if (!wholeShipment && !selected.length) {
    throw new IndeterminateError(provider, 'Transdirect did not identify the requested booking or item');
  }

  const scans = selected.flatMap(item => item.events.map(parseScan))
    .reverse().sort((left, right) => right.timestamp - left.timestamp);
  const summaryCode = wholeShipment ? body.state : selected[0]!.stage;
  const summaryStage = stageForCode(summaryCode);
  const newest = scans[0]?.event;
  const stage = summaryStage ?? scans.find(scan => scan.stage)?.stage;
  const summary = wholeShipment ? clean(body.statusPhrase) : '';
  if (!newest && !summaryStage) throw new NoHistoryError(provider);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(summaryCode ? { provider_code: summaryCode } : {}),
    last_status_text: summary || newest?.description || null,
    last_update: scans.find(scan => scan.event.time)?.event.time ?? null,
    events: scans.map(scan => scan.event),
  };
}
