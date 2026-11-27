/**
 * HUBO's route rows. A newer row carries a node code, which `statuses.json` maps; an older
 * row, or one the code does not settle, is free text by HUBO's staff, often with dates and the
 * vessel, so the map reads the first phrase of `statuses.json` the text contains, in the file's
 * order. A phrase or code listed without a stage is a notice that keeps the stage before it.
 */
import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry {
  readonly code: string | null;
  readonly wording: string;
  readonly stage: string | null;
  readonly note: string;
}

const ENTRIES = statuses.entries as readonly Entry[];
const CODES: ReadonlyMap<string, Entry> = new Map(ENTRIES.flatMap((entry) => (entry.code ? [[entry.code, entry] as const] : [])));
const PHRASES = ENTRIES.filter((entry) => entry.code === null).map((entry) => ({ ...entry, wording: normalizeStatusWording(entry.wording) }));

/** The entry a row reads as: its code's, else the first phrase its `normalizeStatusWording` text contains. */
function entryFor(code: string | null, wording: string): Entry | undefined {
  const coded = code ? CODES.get(code) : undefined;
  if (coded) return coded;
  return wording ? PHRASES.find((entry) => wording.includes(entry.wording)) : undefined;
}

/** The stage HUBO's map gives a row, by its node code and its `normalizeStatusWording` text. */
export function huboStage(code: string | null, wording: string): Stage | undefined {
  return (entryFor(code, wording)?.stage ?? undefined) as Stage | undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: huboStage,
  gaps: ENTRIES.filter((entry) => entry.code && entry.stage === null).map((entry) => ({ code: entry.code!, note: entry.note })),
  gapNote: (code, wording) => {
    const entry = entryFor(code, wording);
    return entry && entry.stage === null ? entry.note : undefined;
  },
};
