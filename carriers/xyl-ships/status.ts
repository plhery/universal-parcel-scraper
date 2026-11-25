import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { wording: string; stage?: string; note?: string };

const ENTRIES = statuses.entries as readonly Entry[];

const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// Customs holding the parcel until its duties are paid, with their amount and currency ("81.97 EUR").
const DUTIES_PENDING = /^customs clearance delayed: (?:\d+(?:[.,]\d+)? [a-z]{3}|…) in duties pending payment\.?$/;

export const xylShipsStage = (_code: string | null, wording: string): Stage | undefined => {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.get(normalized) ?? (DUTIES_PENDING.test(normalized) ? 'customs' : undefined);
};

export const statusMap: CarrierStatusMap = {
  stage: xylShipsStage,
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note! })),
};
