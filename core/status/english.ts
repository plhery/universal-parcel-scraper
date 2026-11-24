/**
 * English for scans a carrier words only in another language. An entry of the
 * carrier's `statuses.json` can give its wording an `english` the adapter shows
 * instead. The map still stages a scan by the carrier's wording, and answers
 * the English too; a scan shown in English takes over the row stored in the
 * carrier's wording.
 */
import type { SameInstantIdentityPolicy, SameInstantScan } from '../catalog/eventIdentity.js';
import type { Stage } from '../../generated/catalog.js';
import { normalizeStatusWording } from './statusMap.js';

/** A `statuses.json` entry, as far as its wording, stage and English go. */
export interface WordedStatus {
  readonly wording: string;
  /** Null for a wording the map lists on purpose without a stage. */
  readonly stage: string | null;
  readonly english?: string | null;
}

export interface StatusWordings {
  /** The stage of a wording in `normalizeStatusWording` form: the carrier's own, or an entry's English. */
  readonly stage: (wording: string) => Stage | undefined;
  /** The English an entry gives a wording in `normalizeStatusWording` form. */
  readonly english: (wording: string) => string | undefined;
  /** Whether an entry lists the wording, or its English, without a stage. */
  readonly unstaged: (wording: string) => boolean;
}

export function statusWordings(entries: readonly WordedStatus[]): StatusWordings {
  const stages = new Map<string, Stage | null>();
  const english = new Map<string, string>();
  for (const entry of entries) {
    stages.set(normalizeStatusWording(entry.wording), entry.stage as Stage | null);
    if (!entry.english) continue;
    english.set(normalizeStatusWording(entry.wording), entry.english);
    stages.set(normalizeStatusWording(entry.english), entry.stage as Stage | null);
  }
  return { stage: (wording) => stages.get(wording) ?? undefined, english: (wording) => english.get(wording),
    unstaged: (wording) => stages.get(wording) === null };
}

/**
 * One scan in either wording: the English shows the other's wording translated,
 * at the same trimmed location, with provider codes that agree when both carry one.
 */
export function translatedScanPolicy(
  carrier: string,
  english: (wording: string) => string | undefined,
): SameInstantIdentityPolicy {
  const translated = (from: SameInstantScan, to: SameInstantScan) => {
    const shown = english(normalizeStatusWording(from.description));
    return shown !== undefined && normalizeStatusWording(shown) === normalizeStatusWording(to.description);
  };
  const matches = (incoming: SameInstantScan, stored: SameInstantScan) =>
    (translated(stored, incoming) || translated(incoming, stored))
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
  return { sourceCarrierId: carrier, storedSources: [carrier], requireProviderCode: false, matchEachScan: true, matches };
}
