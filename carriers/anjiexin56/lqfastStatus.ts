/**
 * The stages of a Lanqiao (lqfast) tenant's rows, apart from the reader so that the status maps
 * browsers load carry no transport. Each firm words its rows on the platform itself, so each has
 * its own `statuses.json`. An entry's wording is a row's as the reader keeps it, without the place
 * that leads it, with `…` standing for the part that varies: another place, a count or a date. An
 * entry marked `unmapped` is a row the map leaves without a stage on purpose. A wording no entry
 * reads goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** An entry of a tenant's `statuses.json`. */
interface LqfastStatusEntry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A tenant's stages and status map from its `statuses.json` entries. */
export function lqfastStatus(entries: readonly LqfastStatusEntry[]): {
  stage: (wording: string) => ClassifiedWording | null; statusMap: CarrierStatusMap;
} {
  const templates = entries.flatMap((entry) => (entry.stage
    ? [[new RegExp(`^${normalizeStatusWording(entry.wording).split('…').map(escape).join('.+?')}$`, 'u'), entry.stage as Stage] as const]
    : []));
  const gaps = entries.flatMap((entry) => (entry.unmapped ? [{ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }] : []));
  const mapped = (wording: string): Stage | undefined => templates.find(([pattern]) => pattern.test(wording))?.[1];
  return {
    stage: (wording) => {
      const key = normalizeStatusWording(wording);
      const stage = mapped(key);
      if (stage) return { stage, source: 'carrier_map' };
      if (gaps.some((gap) => gap.wording === key)) return null;
      const worded = classifyWording(wording, 'in_transit');
      return worded.source === 'none' ? null : worded;
    },
    statusMap: { stage: (code, wording) => (code ? undefined : mapped(wording)), gaps },
  };
}
