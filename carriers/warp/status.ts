import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording?: string; readonly stage: string | null; readonly note?: string }
const ENTRIES = statuses.entries as readonly Entry[];

// The status a WARP event or shipment carries, by code. An event and a shipment status of one
// code stage alike. A departure from a cross-dock titled "Out for delivery" is the last leg.
const BY_CODE = new Map<string, Entry>();
const BY_WORDING = new Map<string, Entry>();
for (const entry of ENTRIES) {
  if (!BY_CODE.has(entry.code)) BY_CODE.set(entry.code, entry);
  if (entry.wording) BY_WORDING.set(`${entry.code}\n${normalizeStatusWording(entry.wording)}`, entry);
}

const entryOf = (code: string, wording: string) => BY_WORDING.get(`${code}\n${normalizeStatusWording(wording)}`) ?? BY_CODE.get(code);

/** The stage of a WARP status code and its wording; null for an appointment notice, undefined for an unknown code. */
export function warpStage(code: string, wording = ''): Stage | null | undefined {
  const entry = entryOf(code, wording);
  return entry ? entry.stage as Stage | null : undefined;
}

/** The label WARP's apps give a shipment status. */
export const warpStatusLabel = (code: string): string | undefined => BY_CODE.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? warpStage(code, wording) ?? undefined : undefined),
  gaps: ENTRIES.filter((entry) => entry.stage === null).map((entry) => ({ code: entry.code, note: entry.note! })),
};
