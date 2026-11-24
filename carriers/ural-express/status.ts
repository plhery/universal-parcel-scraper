import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage: string | null; note?: string };
const entries = statuses.entries as Entry[];

// The TMS's track codes, from its tracking page's bundle and its replies, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(entries
  .filter((entry) => entry.code !== undefined && entry.stage !== null).map((entry) => [entry.code!, entry.stage as Stage]));
// The rows the last mile relays without a code, by their whole wording.
const WORDED: ReadonlyMap<string, Stage> = new Map(entries
  .filter((entry) => entry.code === undefined && entry.stage !== null)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(wording) : CODED.get(code);
}

/** A row's stage by its code, or by its whole wording without one, else the shared rules on its wording, else nothing. */
export function uralStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  if (code !== null && entries.some((entry) => entry.code === code && entry.stage === null)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows are staged by the TMS's code; a relayed row without one by its whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: entries.filter((entry) => entry.code !== undefined && entry.stage === null)
    .map((entry) => ({ code: entry.code!, note: entry.note ?? '' })),
  wholeWording: true,
};
