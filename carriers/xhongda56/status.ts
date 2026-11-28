/**
 * Xinhongda's rows carry no code. Its older sentences name the next hub as written, its newer
 * ones name stations in 【】: an entry of `statuses.json` writes the varying part as `…`. A
 * wording no entry reads goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each entry's wording as a whole-wording pattern, `…` standing for any text.
const TEMPLATES: readonly (readonly [RegExp, Stage])[] = ENTRIES.map((entry) => [
  new RegExp(`^${normalizeStatusWording(entry.wording).split('…').map(escape).join('.+?')}$`, 'u'), entry.stage as Stage] as const);

const mapped = (wording: string): Stage | undefined => TEMPLATES.find(([pattern]) => pattern.test(wording))?.[1];

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? undefined : mapped(wording)), gaps: [] };

/** A row's stage: the map's, else the shared wording rules', or null when neither reads it. */
export function xhongda56Stage(wording: string): ClassifiedWording | null {
  const stage = mapped(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
