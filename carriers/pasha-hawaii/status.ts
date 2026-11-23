import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// The stage each move has in the usual cycle: the empty container leaves the terminal for the
// shipper, comes back full and is loaded, is discharged, leaves with the consignee and comes back
// empty. The empty container's repositioning and the barge's legs keep the stage before them.
const STAGES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The place a move takes place at: the one the container leaves, or the one it reaches. */
export type PashaSide = 'from' | 'to';

// The tracker lists each move from one place to another. A load, a departure or a gate out takes
// place where the container leaves; a discharge, an arrival or a gate in where it arrives.
const SIDES: Readonly<Record<string, PashaSide>> = {
  'dispatch empty': 'from', 'empty gate-out': 'from', 'export ingate': 'to', 'loaded full on vessel': 'from',
  'discharge full from vessel': 'to', 'import outgate': 'from', 'empty ingate': 'to', 'loaded empty on vessel': 'from',
  'disc empty cntr': 'to', 'loaded empty to barge': 'from', 'barge departure': 'from', 'barge arrival': 'to',
  'discharged empty from barge': 'to', 'empty positioning by barge': 'from',
};

/**
 * The stage of a move by its wording alone. The parser stages each move by where it falls in the
 * container's cycle, as an empty container returned before it left full was not used.
 */
export function pashaStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** Where a move takes place, or none for a wording the tracker has not shown. */
export function pashaSide(wording: string): PashaSide | undefined {
  const text = normalizeStatusWording(wording);
  return Object.hasOwn(SIDES, text) ? SIDES[text] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => pashaStage(wording),
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
