/**
 * JD Express USA's rows carry no code, only its own fixed sentences. An entry of `statuses.json`
 * writes a varying part as `…`. A wording no entry reads goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each entry's wording as a whole-wording pattern, `…` standing for any text.
const TEMPLATES: readonly (readonly [RegExp, Stage])[] = ENTRIES.flatMap((entry) => entry.stage
  ? [[new RegExp(`^${normalizeStatusWording(entry.wording).split('…').map(escape).join('.+?')}$`, 'u'), entry.stage as Stage] as const] : []);
const GAPS = ENTRIES.flatMap((entry) => entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }]);

const mapped = (wording: string): Stage | undefined => TEMPLATES.find(([pattern]) => pattern.test(wording))?.[1];

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? undefined : mapped(wording)), gaps: GAPS };

/** A row's stage: the map's, none for a row it leaves out on purpose, else the shared wording rules'. */
export function jdExpressUsaStage(wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  const stage = mapped(key);
  if (stage) return { stage, source: 'carrier_map' };
  if (GAPS.some((gap) => gap.wording === key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
