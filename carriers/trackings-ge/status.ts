import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Trackings.GE words the rows of its tracker, and the status line above them, in the language
 * of the tracker's address; the adapter asks in English. The reply's records carry numeric
 * codes the page words, so the map reads the wording alone.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The order was cancelled before it reached the recipient; code 666 in the reply.
  ['Order canceled', 'exception'],
  // The status line the tracker shows above the rows of such an order.
  ['We are sorry, but it seems that sending of this parcel was canceled', 'exception'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage Trackings.GE's own wording gives a row or the status line. */
export function trackingsGeWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A wording's stage: Trackings.GE's own wording, else the shared wording rules, else nothing. */
export function trackingsGeStage(wording: string): ClassifiedWording | null {
  const mapped = trackingsGeWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => trackingsGeWordingStage(wording),
  gaps: [],
};
