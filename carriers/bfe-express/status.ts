import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// `statuses.json` writes the place a wording names as "…". BFE's own rows name it first, before a comma; the rows
// of a last mile in Spanish name it inside the wording, after "en" where the parcel is there.
const PLACE = '…';
const PLACE_FIRST = `${PLACE}, `;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const placed = (wording: string, place: string) => wording.split(PLACE).map(escape).join(place);

const EXACT = new Map<string, Stage>();
const PATTERNS: (readonly [RegExp, Stage])[] = [];
/** BFE's English rows, which the adapter shows without their place. */
const LEADING: RegExp[] = [];
/** Rows that say the parcel is at the place they name. */
const AT_PLACE: RegExp[] = [];
for (const { wording, stage } of statuses.entries) {
  const key = normalizeStatusWording(wording);
  if (!wording.includes(PLACE)) {
    EXACT.set(key, stage as Stage);
    continue;
  }
  PATTERNS.push([new RegExp(`^${placed(key, '\\S.{0,119}?')}$`), stage as Stage]);
  if (wording.startsWith(PLACE_FIRST)) {
    EXACT.set(key.slice(PLACE_FIRST.length), stage as Stage);
    LEADING.push(new RegExp(`^(\\S.{0,119}?), (${escape(wording.slice(PLACE_FIRST.length))})$`, 'i'));
  } else if (/ en:? …$/.test(wording)) {
    AT_PLACE.push(new RegExp(`^${placed(wording, '(\\S.{0,119})')}$`, 'i'));
  }
}

/** The stage of a BFE Express scan by its `normalizeStatusWording` wording, with its place or without it. */
export function bfeStage(wording: string): Stage | undefined {
  return EXACT.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1];
}

/**
 * A scan's wording as the adapter shows it: one of BFE's English rows without the place it starts with, which becomes
 * its location; a last mile's row as written, with the place it says the parcel is at as its location.
 */
export function bfeWording(written: string): { description: string; location?: string; original_description?: string } {
  for (const pattern of LEADING) {
    const match = pattern.exec(written);
    if (match) return { description: match[2]!, location: match[1]!, original_description: written };
  }
  const place = AT_PLACE.map(pattern => pattern.exec(written)?.[1]).find(Boolean);
  return { description: written, ...(place ? { location: place } : {}) };
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => bfeStage(wording), gaps: [], wholeWording: true };
