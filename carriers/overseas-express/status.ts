import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code?: string; wording: string; stage?: string; note?: string }
const entries: readonly Entry[] = statuses.entries;

// I-NET gives each scan the former system's four-letter code beside its own scan type; both key the map.
const CODES: ReadonlyMap<string, Stage> = new Map(entries.flatMap(entry => (entry.code && entry.stage ? [[entry.code, entry.stage as Stage] as const] : [])));
// The former tracker's Croatian wording, as universal providers relay it without a code.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(entries.flatMap(entry => (!entry.code && entry.stage
  ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : [])));
const gaps = entries.filter(entry => !entry.stage).map(entry => (entry.code
  ? { code: entry.code, note: entry.note! } : { wording: normalizeStatusWording(entry.wording), note: entry.note! }));
const GAP_CODES = new Set(gaps.flatMap(gap => (gap.code ? [gap.code] : [])));

/** A scan's stage by its former code, else its scan type, else the shared rules for its English wording. */
export function overseasStage(legacy: string, type: string, wording: string): ClassifiedWording | null {
  if (GAP_CODES.has(legacy)) return null;
  const mapped = CODES.get(legacy) ?? CODES.get(type);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps,
  wholeWording: true,
};
