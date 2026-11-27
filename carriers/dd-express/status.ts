import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A bracket the tracker leaves at the start of a status without closing it.
const STRAY_BRACKET = /^\[(?!.*\])\s*/;

/** A status as the tracker words it, without a stray opening bracket or spaces around it. */
export function ddExpressWording(status: string): string {
  return status.trim().replace(STRAY_BRACKET, '').trim();
}

// The tracker's statuses have no code: each is staged by its whole wording.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(ddExpressWording(entry.wording)), entry.stage as Stage]));

const mapped = (wording: string): Stage | undefined => WORDED.get(normalizeStatusWording(ddExpressWording(wording)));

/** A status's stage by its whole wording, else by the shared wording rules. */
export function ddExpressStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
  wholeWording: true,
};
