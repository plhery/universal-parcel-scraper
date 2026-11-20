import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { apmLogisticsStage } from './status.js';

export const PROVIDER = 'apm-logistics';
export const MAX_BYTES = 256_000;
const MAX_EVENTS = 300;
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/;
const TIME = /^\d{2}:\d{2}(?::\d{2})?$/;
// The tracker's answer for a waybill it does not know.
const UNKNOWN = 'Shipment tidak ditemukan';
// What the tracker shows for a handover to a partner.
const FORWARDED = 'PAKET DITERUSKAN KE KOTA TUJUAN';

/** A waybill as the tracker takes it: ten digits, as the form's example. */
export function normalizeApmLogisticsNumber(raw: string): string {
  const number = raw.replace(/\s+/g, '');
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter an APM Logistics waybill: ten digits');
  return number;
}

type Scan = CarrierEvent & { local_time: string; description: string; provider_code: string };

const seconds = (clock: string): string => clock.length === 5 ? `${clock}:00` : clock;

function scan(local: string, code: string, description: string, location: string): Scan {
  const stage = apmLogisticsStage(code);
  return { local_time: local, description, ...(location ? { location } : {}), provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

function checkpoint(value: unknown, number: string): Scan {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'APM Logistics returned an unreadable checkpoint');
  if (clean(value.awb_number) !== number) throw new IndeterminateError(PROVIDER, 'APM Logistics answered for another waybill');
  const clock = CLOCK.exec(clean(value.datetime));
  const code = clean(value.code_checkpoint).toUpperCase();
  const year = Number(clock?.[1]?.slice(0, 4));
  if (!clock || year < 2001 || year > 2100 || !code) throw new SchemaError(PROVIDER, 'APM Logistics returned an unreadable checkpoint');
  const description = code === 'FC' || code === 'PAKET DITERIMA VENDOR' ? FORWARDED : clean(value.code_checkpoint);
  return scan(`${clock[1]}T${clock[2]}`, code, description, clean(value.origin_citycode) || clean(value.origin_branch));
}

/** The delivery the reply reports, if any: its status, on its day and time. */
function delivery(value: unknown, destination: string): Scan | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'APM Logistics returned an unreadable delivery');
  const status = clean(value.status);
  if (!status || status === '-') return null;
  const day = DAY.exec(clean(value.date));
  const time = clean(value.time);
  const year = Number(day?.[1]?.slice(0, 4));
  if (!day || year < 2001 || year > 2100) throw new SchemaError(PROVIDER, 'APM Logistics returned an unreadable delivery');
  const clock = day[2] ?? (TIME.test(time) ? time : '');
  return scan(clock ? `${day[1]}T${seconds(clock)}` : day[1]!, status.toUpperCase(), status, destination);
}

/** Reads the tracker's reply, as the browser service passes it on, for the waybill asked. */
export function parseApmLogistics(body: unknown, number: string): CarrierResult {
  if (!isRecord(body) || typeof body.success !== 'boolean') throw new SchemaError(PROVIDER, 'APM Logistics returned an invalid reply');
  if (!body.success) {
    if (body.messages === UNKNOWN) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'APM Logistics did not confirm the waybill');
  }
  if (!isRecord(body.shipment)) throw new SchemaError(PROVIDER, 'APM Logistics returned no shipment');
  if (clean(body.shipment.awb) !== number) throw new IndeterminateError(PROVIDER, 'APM Logistics answered for another waybill');
  if (!Array.isArray(body.checkpoint)) throw new SchemaError(PROVIDER, 'APM Logistics returned no checkpoints');
  if (body.checkpoint.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'APM Logistics returned too many checkpoints');

  const destination = isRecord(body.destination) ? clean(body.destination.city) : '';
  const delivered = delivery(body.delivery, destination);
  const rows = [...body.checkpoint.map((row) => checkpoint(row, number)), ...(delivered ? [delivered] : [])];
  const seen = new Set<string>();
  const events = rows.map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'APM Logistics lists the waybill without checkpoints', { reason: 'listed' });

  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
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
