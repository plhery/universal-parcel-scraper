/**
 * Emile's status vocabulary, for the scans a universal provider relays under
 * Emile's name.
 *
 * `statuses.json` holds the status texts Emile's tracking page maps and the
 * stage each one means. The page looks a text up in capitals, and so does this
 * map. A scan keeps the wording the provider relayed; only its stage comes
 * from the map. A text the map files under no stage (a fee, a reminder) is
 * `pending`, so the parcel keeps the stage it had.
 */
import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>(statuses.entries.map((entry) =>
  [entry.wording.toUpperCase(), (entry.stage ?? 'pending') as Stage]));

/** The stage of one Emile status text a provider relays, and the wording it already stores. */
export function emileScan(label: string): { stage: Stage; wording: string } | undefined {
  const stage = STAGES.get(label.toUpperCase());
  return stage && { stage, wording: label };
}
