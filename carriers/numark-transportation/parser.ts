import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { numarkStage } from './status.js';
import { parseWbprotrk, type WbprotrkTenant } from './wbprotrk.js';

export const PROVIDER = 'numark-transportation';

/** The PRO trace the quick trace form on numarktransportation.net sends a number to. It answers plain HTTP only. */
export const NUMARK_TRACKER = 'http://tracking.numarktransportation.net/cgibin/wbprotrk';

export const NUMARK_TENANT: WbprotrkTenant = {
  provider: PROVIDER, name: 'NuMark Transportation', tracker: NUMARK_TRACKER, stage: numarkStage,
};

// The trace takes five to nine characters and refuses shorter and longer numbers; NuMark's PRO numbers are digits.
const PRO = /^\d{5,9}$/;

/** A NuMark PRO number. Anything else is not one the trace takes. */
export function normalizeNumarkPro(raw: string): string {
  const pro = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!PRO.test(pro)) throw new InvalidInputError(PROVIDER, 'NuMark PRO numbers are five to nine digits');
  return pro;
}

/** Reads the trace's page for one PRO number. */
export const parseNumark = (html: string, pro: string): CarrierResult => parseWbprotrk(html, pro, NUMARK_TENANT);
