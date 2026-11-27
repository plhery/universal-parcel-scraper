import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The steps TMW Express's staff enter for a batch of orders, by their number, with the wording its
 * tracker's script gives each: sorted and waiting for the airport, collected at Perth Airport for
 * customs, moved within Australia, on a connecting flight, in a Chinese customs warehouse under
 * clearance, through the document check and on to the X-ray and tally, then waiting for the
 * Chinese courier that delivers. Steps 0 and 2 have no wording there, and the tracker hides them.
 */
const STEPS: ReadonlyMap<string, { wording: string; stage: Stage }> = new Map([
  ['4', { wording: '包裏分拣完毕，等待机场揽收', stage: 'accepted' }],
  ['6', { wording: '珀斯机场海关揽收', stage: 'in_transit' }],
  ['7', { wording: '澳洲境内中转', stage: 'in_transit' }],
  ['8', { wording: '航班中转', stage: 'in_transit' }],
  ['10', { wording: '已抵达中国海关监管仓库，清关中', stage: 'customs' }],
  ['12', { wording: '中国海关审完单，过机理货中', stage: 'customs' }],
  ['99', { wording: '等待国内派送', stage: 'in_transit' }],
] as const);

/** The stage of a step by its number, whatever wording the reply gives it. */
export function tmwStepStage(code: string): Stage | undefined {
  return STEPS.get(code)?.stage;
}

/** The wording the tracker's script gives a step. */
export function tmwStepWording(code: string): string | undefined {
  return STEPS.get(code)?.wording;
}

/** A Chinese courier's row, which has no code: the shared wording rules, else nothing. */
export function tmwRecordStage(wording: string): ClassifiedWording | null {
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? tmwStepStage(code) : undefined), gaps: [] };
