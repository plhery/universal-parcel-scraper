import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Parcel2Go';

const portalStages: ReadonlyMap<string, Stage> = new Map([
  ['DroppedOff', 'accepted'],
  ['Collected', 'accepted'],
  ['InTransit', 'in_transit'],
  ['AtDepot', 'in_transit'],
  ['Delivered', 'delivered'],
]);

export function parcel2goNumber(input: string): string {
  const number = input.trim().toUpperCase();
  if (!/^P2G\d{8,9}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Parcel2Go P2G reference');
  return number;
}

function scan(raw: unknown): CarrierEvent | null {
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Parcel2Go returned an unreadable scan');
  if (raw.type === 'Collection Scheduled' || raw.type === 'Delivery Scheduled') return null;

  const description = clean(raw.description, 300) || clean(raw.type, 100);
  const explicit = explicitOffsetTime(raw.timestamp);
  // Validate the calendar digits on UTC without assigning UTC to a partner scan.
  const wall = typeof raw.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw.timestamp)
    ? isoTime(raw.timestamp, 'UTC')?.iso.slice(0, 19)
    : undefined;
  if (!description || (!explicit && !wall)) throw new SchemaError(PROVIDER, 'Parcel2Go returned an incomplete scan');

  const code = clean(raw.code, 30);
  const stage = statusMap.stage(code || null, description)
    ?? (typeof raw.stage === 'string' ? portalStages.get(raw.stage) : undefined);
  const location = typeof raw.detail === 'string' ? clean(/^Location:\s*([^\r\n]+)$/i.exec(raw.detail)?.[1], 180) : '';
  return {
    ...(explicit ? { time: explicit.iso } : { local_time: wall! }),
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

export function parseParcel2Go(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (payload.success === false && isRecord(payload.error) && payload.error.code === '404.1'
    && payload.error.message === 'Unable to find orderline' && payload.result === null) {
    throw new NotFoundError(PROVIDER);
  }
  if (payload.success !== true || !isRecord(payload.result)) throw new SchemaError(PROVIDER);

  const { order, parcels, parcelCount } = payload.result;
  // A P2G reference is the order-line identifier. The numeric order id is a separate field.
  if (!isRecord(order) || order.foundOrder !== true || typeof order.orderLineId !== 'number'
    || order.orderLineId !== Number(number.slice(3))) {
    throw new SchemaError(PROVIDER, 'Parcel2Go did not identify the requested reference');
  }
  if (!isRecord(parcels) || Object.keys(parcels).length !== parcelCount) {
    throw new SchemaError(PROVIDER, 'Parcel2Go returned an incomplete list of parcels');
  }

  const pieces = Object.values(parcels).map(piece => {
    if (!isRecord(piece) || typeof piece.delivered !== 'boolean' || !Array.isArray(piece.events)) {
      throw new SchemaError(PROVIDER, 'Parcel2Go returned an unreadable parcel');
    }
    return { delivered: piece.delivered, events: piece.events.map(scan).filter(event => event !== null) };
  });

  // When a booking contains several pieces, follow an unfinished piece until all are delivered.
  const allDelivered = pieces.every(piece => piece.delivered);
  const events = pieces
    .filter(piece => allDelivered || !piece.delivered)
    .map(piece => piece.events)
    .sort((a, b) => (b[0]?.time ?? b[0]?.local_time ?? '').localeCompare(a[0]?.time ?? a[0]?.local_time ?? ''))[0] ?? [];
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const stage = latest.stage as Stage | undefined;
  if (stage === 'delivered' && !allDelivered) {
    throw new SchemaError(PROVIDER, 'Parcel2Go returned contradictory delivery status for a piece');
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    expected_delivery: null,
    ...(stage === 'delivered' && allDelivered && latest.time ? { delivered_at: latest.time } : {}),
    events: events.slice(0, 100),
    ...(pieces.length > 1 || events.length > 100 ? { history_truncated: true } : {}),
  };
}
