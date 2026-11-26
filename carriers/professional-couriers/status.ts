import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the phrases TPC's scans open with, as recorded in `statuses.json`. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.code && entry.stage)
  .map(entry => [entry.code!, entry.stage as Stage]));
const LOWER: ReadonlyMap<string, Stage> = new Map([...CODES].map(([code, stage]) => [code.toLowerCase(), stage]));
// Longest first, so "Bag Despatched to" is not read as "Despatched to".
const PHRASES = [...CODES.keys()].sort((a, b) => b.length - a.length);

/**
 * The phrase a scan opens with, which stands for its scan type: a recorded phrase, or the words
 * before " - Area :" for a delivery-area scan none records.
 */
export function professionalCouriersCode(wording: string): string | undefined {
  const text = wording.replace(/\s+/g, ' ').trim();
  const known = PHRASES.find(phrase => text.toLowerCase() === phrase.toLowerCase() || text.toLowerCase().startsWith(`${phrase.toLowerCase()} `));
  if (known) return known;
  return /^([A-Za-z][A-Za-z ]{1,40}?) - Area :/.exec(text)?.[1];
}

export function professionalCouriersStage(code: string): Stage | undefined {
  return CODES.get(code);
}

// Universal providers relay TPC's wording without its phrase, and the map gets it lowercased.
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? LOWER.get(professionalCouriersCode(wording)?.toLowerCase() ?? ''),
  gaps: [],
};
