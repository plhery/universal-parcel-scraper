import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { dhlEcommerceNlStatus, statusForStage } from './status.js';

const PROVIDER = 'DHL eCommerce Netherlands';
const MAX_SCANS = 1_000;
const MAX_EVENTS = 100;
const NOT_FOUND = 'No parcel found for the given key(s)';
/** Stages that end a parcel's journey; a later notice or reminder does not undo them. */
const FINAL: readonly Stage[] = ['delivered', 'returned'];

/** The Benelux label families: JVGL and 3S barcodes, and the JJD licence plate of DHL's European road network. */
export function normalizeDhlEcommerceNlNumber(raw: string): string {
  const number = raw.trim().toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?:JVGL[A-Z0-9]{8,30}|3S[A-Z0-9]{9,18}|JJD[A-Z0-9]{8,30})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'DHL eCommerce Netherlands tracking requires a JVGL, 3S or JJD number');
  }
  return number;
}

/** The gateway answers an unknown key with one fixed sentence; any other 404 says nothing about the parcel. */
export function parseDhlEcommerceNlNotFound(body: string): never {
  if (body.trim() === NOT_FOUND) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'DHL eCommerce Netherlands returned an inconclusive tracking error');
}

function instant(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? explicitOffsetTime(value)?.iso : undefined;
}

export function parseDhlEcommerceNl(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDhlEcommerceNlNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'DHL eCommerce Netherlands returned an invalid tracking response');
  const matches = payload.filter(isRecord).filter((shipment) => shipment.barcode === number
    || (Array.isArray(shipment.barcodes) && shipment.barcodes.includes(number)));
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'DHL eCommerce Netherlands did not return one matching shipment');
  const shipment = matches[0]!;
  if (!Array.isArray(shipment.events) || shipment.events.length > MAX_SCANS) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Netherlands returned invalid tracking events');
  }
  // The feed is oldest first and repeats a scan it received from two systems.
  const events: (CarrierEvent & { stage?: Stage })[] = [];
  const seen = new Set<string>();
  let window: string | undefined;
  for (const row of shipment.events) {
    if (!isRecord(row) || typeof row.status !== 'string' || !/^[A-Z0-9][A-Z0-9_/-]{0,119}$/.test(row.status)) {
      throw new SchemaError(PROVIDER, 'DHL eCommerce Netherlands returned an invalid parcel scan');
    }
    const time = instant(row.timestamp) ?? instant(row.localTimestamp);
    if (typeof row.plannedDeliveryTimeframe === 'string') window = row.plannedDeliveryTimeframe;
    const key = `${row.status}|${time ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { description, stage } = dhlEcommerceNlStatus(row.status, row.category);
    events.push({ provider_code: row.status, description, ...(time ? { time } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Netherlands returned no parcel history');
  events.reverse();
  const latest = events[0]!;
  const final = events.find((event) => event.stage && FINAL.includes(event.stage));
  const current = final ?? latest;
  const stage = current.stage;
  const deliveredAt = stage === 'delivered' ? current.time ?? instant(shipment.deliveredAt) : undefined;
  // The planned window is a pair of local clocks; only its day is kept.
  const planned = /^\d{4}-\d{2}-\d{2}T[^/]+\/(\d{4}-\d{2}-\d{2})T/.exec(window ?? '')?.[1];
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description ?? null,
    last_update: latest.time ?? null,
    expected_delivery: stage && (FINAL.includes(stage) || stage === 'ready_for_pickup') ? null : planned ?? null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
