import type { CarrierResult } from '../../core/result/index.js';
import { itdidaNumber, parseItdida, type ItdidaTenant } from '../whwdt/itdida.js';
import { statusMap, xunTianStage } from './status.js';

export const PROVIDER = 'Xun Tian International';
export const CARRIER = 'xun-tian-international';
export const XUN_TIAN_HOST = 'xtl.itdida.com';

/** Xun Tian's numbers: the lookup takes its waybills, references and onward numbers alike. */
export function normalizeXunTianNumber(raw: string): string {
  return itdidaNumber(raw, PROVIDER);
}

/**
 * Xun Tian International's (迅田国际) ITDIDA tenant, `xtl`. On its line to
 * Japan the rows run from the gateway in Guangzhou through Japanese customs to
 * the delivery, each on the clock of the place it happened.
 */
export const XUN_TIAN: ItdidaTenant = {
  carrier: CARRIER, provider: PROVIDER, host: XUN_TIAN_HOST, normalize: normalizeXunTianNumber,
  stage: (wording) => xunTianStage(wording), statusMap,
};

/** The reply of the tenant's `queryTracks` lookup. */
export function parseXunTian(payload: unknown, raw: string): CarrierResult {
  return parseItdida(XUN_TIAN, payload, raw);
}
