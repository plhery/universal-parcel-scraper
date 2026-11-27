import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { itdidaNumber, parseItdida, type ItdidaTenant } from '../whwdt/itdida.js';
import { statusMap, uSpeedStage } from './status.js';

export const PROVIDER = 'U-Speed Express';
export const CARRIER = 'u-speed-express';
/** The forwarder's own domain, which serves its ITDIDA tenant's lookup. */
export const U_SPEED_HOST = 'www.u-speedex.com';
// The place of the text messages the Israeli delivery partner sends the recipient, which name the
// recipient, their street address, the driver and the driver's phone.
const MESSAGE = 'sms';
// The Israeli partner's status names, which it puts where the place goes: "closed" and "new".
const STATUS_NAMES: ReadonlySet<string> = new Set(['סגור', 'חדש']);

const placeOf = (row: Record<string, unknown>) => (typeof row.localtion === 'string' ? row.localtion.trim() : '');

/** U-Speed's numbers: the lookup takes its system, transfer and customer numbers alike. */
export function normalizeUSpeedNumber(raw: string): string {
  return itdidaNumber(raw, PROVIDER);
}

/** The rows that are scans of the parcel, without the partner's text messages or its status names as places. */
export function uSpeedRows(rows: unknown[]): unknown[] {
  return rows.filter((row) => !isRecord(row) || placeOf(row).toLowerCase() !== MESSAGE)
    .map((row) => (isRecord(row) && STATUS_NAMES.has(placeOf(row)) ? { ...row, localtion: '' } : row));
}

/**
 * U-Speed Express's (优时派) ITDIDA tenant, which its site serves on its own
 * domain. On its line to Israel the rows are the Israeli import partner's,
 * from the order's data through customs to the delivery, on Israel's clock.
 */
export const U_SPEED: ItdidaTenant = {
  carrier: CARRIER, provider: PROVIDER, host: U_SPEED_HOST, normalize: normalizeUSpeedNumber,
  stage: (wording) => uSpeedStage(wording), statusMap, rows: uSpeedRows,
};

/** The reply of the tenant's `queryTracks` lookup. */
export function parseUSpeed(payload: unknown, raw: string): CarrierResult {
  return parseItdida(U_SPEED, payload, raw);
}
