import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the tracker's wordings, which carry no code, as recorded in `statuses.json`. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** "Usluga - …": a service the recipient or sender asked for, such as a pickup point instead of the door. */
const SERVICE = /^usluga - \S/;
const SERVICE_NOTE = 'A service asked for the delivery, such as sending the shipment to a pickup point; it moves nothing, so the scan keeps the stage of the one before it.';

export function xExpressRsStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)),
  gaps: [],
  gapNote: (code, wording) => (!code && SERVICE.test(wording) ? SERVICE_NOTE : undefined),
  wholeWording: true,
};
