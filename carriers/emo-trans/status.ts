import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A milestone's name is the whole wording, the same in the events table and as the summary's last status.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry): entry is typeof entry & { stage: string } => typeof entry.stage === 'string')
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

const CARTAGE_NOTE = 'EMO tells the trucker who will deliver the shipment that it is coming; it says nothing of where the freight is, so the stage stays that of the event before.';

/** The stage of a milestone by its name, or undefined for a name EMO Trans's map does not know. */
export const emoTransStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

/** Milestones carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : BY_WORDING.get(wording)),
  gaps: [{ wording: 'delivery cartage advised', note: CARTAGE_NOTE }],
  wholeWording: true,
};
