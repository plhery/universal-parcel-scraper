import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * E24's statuses as FarEye's tracker words them: in English, in French, or both joined by a slash, as the link
 * the tracker gives is set. They carry no code, so the wording alone stages them.
 */
const ENTRIES = statuses.entries as readonly { wording: string; stage?: Stage }[];
const WORDED: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => (entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage]] : [])));

/**
 * The stage of a status's wording, in `normalizeStatusWording` form: the whole wording, else the English and
 * French halves of a bilingual one when every half the map knows has the same stage.
 */
export function e24Stage(wording: string): Stage | undefined {
  const whole = WORDED.get(wording);
  if (whole || !wording.includes('/')) return whole;
  const stages = new Set(wording.split('/').flatMap((half) => {
    const stage = WORDED.get(normalizeStatusWording(half));
    return stage ? [stage] : [];
  }));
  return stages.size === 1 ? [...stages][0] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : e24Stage(wording)),
  gaps: [],
  wholeWording: true,
};
