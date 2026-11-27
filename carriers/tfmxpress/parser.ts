import type { CarrierResult } from '../../core/result/index.js';
import { normalizeEzyFmsNumber, parseEzyFms, type EzyFmsTenant } from './ezyfms.js';
import { statusMap, tfmxpressStage } from './status.js';

export const PROVIDER = 'TFMXpress';
export const CARRIER = 'tfmxpress';

/**
 * TFMXpress's tenant of EzyFMS, at `/tfm/`. A depot no city names is read on Melbourne's
 * clock, the catalog's zone for TFMXpress, whose site lists its Victorian depot first.
 */
export const TFMXPRESS: EzyFmsTenant = {
  carrier: CARRIER, provider: PROVIDER, path: 'tfm', zone: 'Australia/Melbourne', stage: tfmxpressStage, statusMap,
};

/** A consignment number as TFMXpress's tracker takes it. */
export const normalizeTfmxpressNumber = (raw: string): string => normalizeEzyFmsNumber(raw, TFMXPRESS);

/** The page TFMXpress's tracker renders for one consignment number. */
export const parseTfmxpress = (html: string, raw: string): CarrierResult => parseEzyFms(TFMXPRESS, html, raw);
