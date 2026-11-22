import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { cautCurierLabel, cautCurierStage } from './status.js';

export const PROVIDER = 'CautCurier';
/** The tracking page's lookup, which answers one AWB with its order. */
export const CAUTCURIER_ENDPOINT = 'https://tracking-api.cautcurier.ro/api/Tracker/GetOrderDetails';
/** The server's reply for an AWB it has no order for, as HTTP 500. */
const MISSING = 'Object reference not set to an instance of an object.';
const MAX_EVENTS = 100;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;

/** An AWB: the order's id, digits only, as the tracking page requires. */
export function normalizeCautCurierNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[1-9]\d{3,11}$/.test(number)) throw new InvalidInputError(PROVIDER, 'CautCurier AWBs are the order number, digits only');
  return number;
}

/** Whether a reply is the server's whole answer for an AWB it has no order for, and nothing else. */
export function isCautCurierNotFound(payload: unknown): boolean {
  const body = record(payload);
  return !!body && Object.keys(body).length === 1 && body.message === MISSING;
}

/**
 * The lookup's order for one AWB: its id, which must be the AWB asked, its current type, the
 * masked sender and recipient, its weight and its events, each a type and a Unix time in seconds.
 * The parties are left out.
 */
export function parseCautCurier(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCautCurierNumber(raw);
  const body = record(payload);
  if (!body || body.success !== true) throw new SchemaError(PROVIDER, 'CautCurier returned an unsuccessful reply');
  const order = record(body.data);
  if (!order) throw new SchemaError(PROVIDER, 'CautCurier returned a reply without an order');
  // The lookup could answer for another order; only the whole AWB counts.
  if (cleanScalar(order.id, 32) !== number) throw new SchemaError(PROVIDER, 'CautCurier answered for another order');
  const items = order.eventItems ?? [];
  if (!Array.isArray(items)) throw new SchemaError(PROVIDER, 'CautCurier returned invalid events');
  if (items.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'CautCurier returned too many events');
  const dated: { at: number; event: CarrierEvent }[] = [], seen = new Set<string>();
  for (const item of items) {
    const type = clean(record(item)?.type, 64);
    const time = epochSecondsTime(record(item)?.timestamp);
    if (!type || !time) throw new SchemaError(PROVIDER, 'CautCurier returned an invalid event');
    const stage = cautCurierStage(type);
    const event: CarrierEvent = { time: time.iso, description: cautCurierLabel(type) ?? type, provider_code: type,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); dated.push({ at: time.timestamp, event }); }
  }
  // Newest first: the reply lists events oldest first, and events of one second keep its order reversed.
  const events = dated.reverse().sort((a, b) => b.at - a.at).map(({ event }) => event);
  const current = clean(order.orderStatus, 64);
  const newest = events[0];
  if (!current && !newest) throw new SchemaError(PROVIDER, 'CautCurier returned an order without a status or events');
  // The order's own type is its current status; its events can lag behind it.
  const type = current || String(newest!.provider_code);
  const stage = cautCurierStage(type);
  const weight = Number(cleanScalar(order.packageWeight, 16));
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: cautCurierLabel(type) ?? type, last_update: newest?.time ?? null,
    ...(newest ? {} : { provider_code: type, summary_only: true }),
    ...(Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}), events };
}
