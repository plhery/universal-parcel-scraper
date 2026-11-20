import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst, withTieOrder } from '../../core/result/order.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { obanaStage } from './status.js';

const carrier = 'obana-logistics';

export function parseTracking(text: string, httpStatus: number, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Obana Logistics returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Obana Logistics returned invalid tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.success === false && reply.message === 'Shipment not found') {
    throw new NotFoundError(carrier);
  }
  if (httpStatus !== 200 || !isRecord(reply) || reply.success !== true || !isRecord(reply.data)) {
    throw new SchemaError(carrier, 'Obana Logistics changed its public tracking reply');
  }
  const data = reply.data;
  const echoed = clean(data.shipment_reference, 64);
  const code = clean(data.status, 64);
  const displayed = clean(data.display_status, 150);
  if (!echoed || !code || !Array.isArray(data.tracking_events) || data.tracking_events.length > 500) {
    throw new SchemaError(carrier, 'Obana Logistics changed its shipment or event fields');
  }
  if (echoed.toUpperCase() !== number) throw new IndeterminateError(carrier, 'Obana Logistics returned a different shipment reference');

  const rows: { event: CarrierEvent; timestamp: number }[] = [];
  for (const item of data.tracking_events as unknown[]) {
    if (!isRecord(item)) throw new SchemaError(carrier, 'Obana Logistics changed its tracking event');
    const eventCode = clean(item.status, 64);
    const description = clean(item.description, 250) || eventCode;
    const time = explicitOffsetTime(item.createdAt);
    if (!description || !time) throw new SchemaError(carrier, 'Obana Logistics changed its scan status or timestamp');
    const stage = obanaStage(eventCode || null, description);
    rows.push({
      event: {
        description, time: time.iso,
        ...(eventCode && { provider_code: eventCode }),
        ...(stage && { stage, stage_source: 'explicit_mapping' }),
      },
      timestamp: time.timestamp,
    });
  }
  const sourceEvents = rows.map(({ event }) => event);
  withTieOrder(sourceEvents);
  if (listsNewestFirst(sourceEvents) === false) rows.reverse();
  rows.sort((left, right) => right.timestamp - left.timestamp);
  const events = rows.map(({ event }) => event);
  const current = obanaStage(code, displayed);
  const delivery = current === 'delivered' ? explicitOffsetTime(data.actual_delivery_at) : null;
  const statusEvent = events.find((event) => current ? event.stage === current : event.provider_code === code);
  const receivedAt = current === 'registered' ? explicitOffsetTime(data.createdAt) : null;
  const service = clean(data.service_level, 80);
  const destination = isRecord(data.delivery_address) ? clean(data.delivery_address.country, 80) : '';
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current && { current_stage: current, current_stage_source: 'explicit_mapping' }),
    provider_code: code, last_status_text: displayed || code,
    last_update: delivery?.iso ?? statusEvent?.time ?? receivedAt?.iso ?? null,
    ...(delivery && { delivered_at: delivery.iso }),
    ...(service && { service_name: service }),
    ...(destination && { destination_country_name: destination }),
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
    ...(!events.length && { summary_only: true }),
  };
}
