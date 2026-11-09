import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const key = (code: string | null, wording: string) => `${code ?? ''}\0${normalizeStatusWording(wording)}`;
const ENTRIES: readonly Entry[] = statuses.entries;
const MAP: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(x => x.wording && x.stage)
  .map(x => [key(x.code ?? null, x.wording!), x.stage as Stage]));
const GAP = normalizeStatusWording('Партионный');

export function zesExpressStage(wording: string, code: string): ClassifiedWording | null {
  const stage = MAP.get(key(code, wording));
  if (stage) return { stage, source: 'carrier_map' };
  if (!code && normalizeStatusWording(wording) === GAP) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => MAP.get(key(code, wording)),
  gaps: [{ wording: GAP, note: 'A bulk-processing label, without a delivery milestone of its own.' }],
};
