import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string; readonly note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// The tracker's status letters, with the sentence its page shows for each. The first entry of a
// letter is its sentence; a later one is the sentence the page shows instead in a special case.
const CODED = ENTRIES.filter((entry) => entry.code && entry.stage);
// A row's wording from the tracker's rows, which carry no code.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// "X" with exception code 5: the courier could not deliver and tries again the next working day.
const RETRY = CODED.find((entry) => entry.code === 'X' && entry.stage === 'failed_attempt')!;

// A letter with the page's sentence for a special case reads as that case, else as the letter.
const coded = (code: string, wording: string): Entry | undefined =>
  CODED.find((entry) => entry.code === code && normalizeStatusWording(entry.wording) === wording)
  ?? CODED.find((entry) => entry.code === code);

/** The entry the page shows for a status letter and the shipment's exception code. */
function entryOf(code: string, exception?: number): Entry | undefined {
  return code === 'X' && exception === 5 ? RETRY : CODED.find((entry) => entry.code === code);
}

export const spedireCodeStage = (code: string, exception?: number): Stage | undefined => entryOf(code, exception)?.stage as Stage | undefined;
export const spedireStatusText = (code: string, exception?: number): string | undefined => entryOf(code, exception)?.wording;

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function spedireRowStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? coded(code, wording)?.stage as Stage | undefined : WORDINGS.get(wording)),
  gaps: [],
};
