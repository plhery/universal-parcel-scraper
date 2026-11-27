import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A scan's wording, and the row's own status (`Status`), which comes as the entry's code.
const SCANS = statuses.entries.filter((entry) => !('code' in entry));
const ROWS = statuses.entries.filter((entry): entry is typeof entry & { code: string } => 'code' in entry);
const WORDINGS = statusWordings(SCANS);
const ROW_STAGES: ReadonlyMap<string, Stage | null> = new Map(ROWS.map((entry) => [entry.code.toLowerCase(), entry.stage as Stage | null]));

// The consolidation names its master air waybill: "Add Hawb to Mawb 999-12345675". It is listed as "…".
const MAWB = /^(add hawb to mawb) \S.*$/;

/** The wording a scan is listed under, in `normalizeStatusWording` form. */
const key = (wording: string): string => normalizeStatusWording(wording).replace(MAWB, '$1 …');

/** The stage DPD China's map gives a scan by its wording, or a row by its status code. */
export function dpdCnStage(code: string | null, wording: string): Stage | undefined {
  return code ? ROW_STAGES.get(code.toLowerCase()) ?? undefined : WORDINGS.stage(key(wording));
}

/** The stage of a row's own status: `Unpickup`, `InTransit`, `Delivered`, `Return` or `Exception`. */
export function dpdCnRowStage(code: string): Stage | undefined {
  return code ? dpdCnStage(code, '') : undefined;
}

/**
 * Whether the map lists a scan's wording without a stage: a notice to the recipient, the recipient's
 * choice of where to leave the parcel, or the signature and proof of delivery after the delivery. None
 * moves the parcel, so it keeps the stage of the scan before it.
 */
export const isDpdCnNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

// Why each scan wording and row status listed without a stage has none.
const SCAN_NOTES = new Map(SCANS.filter((entry) => entry.stage === null).map((entry) => [normalizeStatusWording(entry.wording), entry.note]));
const ROW_NOTES = new Map(ROWS.filter((entry) => entry.stage === null).map((entry) => [entry.code.toLowerCase(), entry.note]));

export const statusMap: CarrierStatusMap = {
  stage: dpdCnStage, gaps: [], wholeWording: true,
  gapNote: (code, wording) => (code ? ROW_NOTES.get(code.toLowerCase()) : SCAN_NOTES.get(key(wording))),
};
