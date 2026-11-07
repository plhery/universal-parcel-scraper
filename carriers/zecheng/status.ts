import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { CTTYEX_NOT_FOUND, cttyexMappedStage, cttyexStage } from '../cttyex/status.js';

/**
 * Zecheng's tracker is CTTYEX's system, and its scans are read as CTTYEX's
 * are: by their wording, as it shows no codes.
 */
export const zechengMappedStage = cttyexMappedStage;
/** A scan's stage: the map, else the shared wording rules, else nothing. */
export const zechengStage = cttyexStage;
/** The tracker's status for a number it does not know, in Chinese and in English. */
export const ZECHENG_NOT_FOUND = CTTYEX_NOT_FOUND;

/** What the map says about one scan or summary, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : zechengMappedStage(wording)),
  gaps: ZECHENG_NOT_FOUND.map((wording) => ({ wording: normalizeStatusWording(wording),
    note: 'The tracker\'s status for a number it does not know, which the adapter reads as not found; never a scan.' })),
};
