/**
 * Shengtai's rows carry no code: each is a sentence the system fills with the hub or station in
 * brackets. `statuses.json` gives each sentence's stage, with `…` for the part that varies; an
 * entry marked `unmapped` is a notice the map leaves without a stage on purpose. Wording no entry
 * reads goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each entry's wording as a whole-wording pattern, `…` standing for any text.
const TEMPLATES = ENTRIES.map((entry) => ({ entry,
  pattern: new RegExp(`^${normalizeStatusWording(entry.wording).split('…').map(escape).join('.+?')}$`, 'u') }));

const entryOf = (wording: string): Entry | undefined => TEMPLATES.find(({ pattern }) => pattern.test(wording))?.entry;
const mapped = (wording: string): Stage | undefined => entryOf(wording)?.stage as Stage | undefined;

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mapped(wording)),
  gaps: [],
  gapNote: (code, wording) => {
    const entry = code ? undefined : entryOf(wording);
    return entry?.unmapped ? entry.note : undefined;
  },
};

/** A row's stage: the map's, else the shared wording rules', or null for a notice or wording neither reads. */
export function stwlesStage(wording: string): ClassifiedWording | null {
  const entry = entryOf(normalizeStatusWording(wording));
  if (entry) return entry.stage ? { stage: entry.stage as Stage, source: 'carrier_map' } : null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
