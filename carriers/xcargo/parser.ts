import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isXcargoReference } from '../../core/detection/xcargo.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { xcargoState } from './status.js';

export const PROVIDER = 'X-Cargo';
export const WIDGET_URL = 'https://x-cargo.co/wp-content/uploads/BigTracking/big-tracker.min.js';
export const MAX_BYTES = 1024 * 1024;
const MISSING = 'No se encontró ningún elemento para ese identificador.';

export function normalizeXcargoNumber(raw: string): string {
  if (!isXcargoReference(raw)) throw new InvalidInputError(PROVIDER, 'X-Cargo requires a whole sixteen-digit reference');
  return normalizeTrackingNumber(raw);
}

export function xcargoUrl(raw: string): string {
  return 'https://api.bigsmart.mx/api/order-logs/' + normalizeXcargoNumber(raw) + '?populate=true&language=es';
}

export function assertXcargoGuestText(text: string): void {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden)|_cf_chl_opt|verify (?:that )?you are human|incapsula incident id/i.test(text)) {
    throw new ChallengeError(PROVIDER, 'X-Cargo returned browser verification');
  }
}

/** The public widget distributes this same read-only visitor credential to every guest. */
export function xcargoVisitorToken(script: string, now = Date.now()): string {
  assertXcargoGuestText(script);
  const tokens = [...new Set(script.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [])];
  if (tokens.length !== 1 || tokens[0]!.length > 8192) throw new SchemaError(PROVIDER, 'X-Cargo returned ambiguous visitor configuration');
  try {
    const part = tokens[0]!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
    if (!isRecord(claims) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new Error('Invalid expiry');
    if (claims.exp * 1000 <= now) throw new ChallengeError(PROVIDER, 'X-Cargo visitor configuration has expired');
  } catch (error) {
    if (error instanceof ChallengeError) throw error;
    throw new SchemaError(PROVIDER, 'X-Cargo returned invalid visitor configuration');
  }
  return tokens[0]!;
}

function clock(value: unknown, zone: unknown): string {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  const offset = typeof zone === 'string' && /^GMT([+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(zone);
  if (!match || !offset || Number(match[1]) < 2000 || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
    || /^[+-]14:(?!00)/.test(offset[1]!)) throw new SchemaError(PROVIDER, 'X-Cargo returned an invalid scan clock or offset');
  const result = explicitOffsetTime(`${match[1]}-${match[2]}-${match[3]}T${match[4]}${offset[1]}`);
  if (!result) throw new SchemaError(PROVIDER, 'X-Cargo returned an invalid scan instant');
  return result.iso;
}

function identifier(value: unknown): boolean {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

/** Bind the group reference and every order row; never infer X-Cargo from the platform alone. */
export function parseXcargo(payload: unknown, raw: string, httpStatus = 200): CarrierResult {
  const number = normalizeXcargoNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'X-Cargo returned no tracking object');
  if (httpStatus === 404 && payload.message === MISSING && payload.error === MISSING && Object.keys(payload).length === 2) {
    throw new NotFoundError(PROVIDER);
  }
  if (httpStatus !== 200) throw new IndeterminateError(PROVIDER, 'X-Cargo did not complete its guest lookup');
  if (payload.tracking_number !== number || payload.reference_tracking_number !== number || !identifier(payload.id)) {
    throw new SchemaError(PROVIDER, 'X-Cargo returned another tracking identity');
  }
  if (typeof payload.primary_client_name !== 'string' || payload.primary_client_name.trim().toLowerCase() !== 'fontylink') {
    throw new NoHistoryError(PROVIDER, 'The shared platform did not confirm an X-Cargo group shipment', { reason: 'unsupported_network' });
  }
  if (!Array.isArray(payload.data) || payload.data.length > 500) throw new SchemaError(PROVIDER, 'X-Cargo returned an invalid scan list');
  if (!payload.data.length) throw new NoHistoryError(PROVIDER, 'X-Cargo returned no dated history');
  const rows: { event: CarrierEvent; index: number; timestamp: number }[] = [];
  const seen = new Set<string>(); let partial = false;
  for (const [index, row] of (payload.data as unknown[]).entries()) {
    if (!isRecord(row) || row.order_id !== payload.id || !isRecord(row.status_code)
      || !Number.isSafeInteger(row.status_code.code) || Number(row.status_code.code) < 0 || Number(row.status_code.code) > 99999
      || typeof row.status_code.code_type !== 'string' || !/^[a-z_]{1,32}$/.test(row.status_code.code_type)) {
      throw new SchemaError(PROVIDER, 'X-Cargo returned an unbound scan or invalid status');
    }
    const code = String(row.status_code.code), mapped = xcargoState(code), time = clock(row.created_at, row.gmt_offset);
    if (mapped && mapped.type !== row.status_code.code_type) throw new SchemaError(PROVIDER, 'X-Cargo changed a scan status meaning');
    if (!mapped) partial = true;
    // Notes, employees, proof, GPS and free wording are deliberately excluded.
    const event: CarrierEvent = { time, provider_code: code, description: mapped?.description ?? 'Tracking update',
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); rows.push({ event, index, timestamp: Date.parse(time) }); }
  }
  // Stated offsets determine instants; equal-time source rows keep their order.
  rows.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
  const newest = rows[0]!.event, stage = xcargoState(newest.provider_code!)?.stage;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}), provider_code: newest.provider_code,
    last_status_text: newest.description, last_update: newest.time!, expected_delivery: null,
    ...(partial || rows.length > 100 ? { history_truncated: true } : {}), events: rows.slice(0, 100).map(row => row.event) };
}
