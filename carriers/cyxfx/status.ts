/**
 * C&Y's rows: a status code, its label and a remark, kept as the scan's code and wording. An entry of
 * `statuses.json` records a code with a remark, the courier's number in a hand-off as an ellipsis. A code
 * whose every recorded remark means one stage gives it to a remark the map does not know; code 110 is the
 * hand-off to the courier in China and the delivery alike, so it needs the remark. Anything else goes through
 * the shared wording rules, the remark's and then the label's.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// "单号:329250071839": the courier's number a hand-off row ends with.
const template = (wording: string): string => wording.replace(/(单号\s*[:：]\s*)[a-z0-9]{8,30}/giu, '$1…');
const key = (code: string | null | undefined, wording: string) => JSON.stringify([code ?? '', template(normalizeStatusWording(wording))]);
const MAPPED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));
const STAGES_BY_CODE = new Map<string, Set<Stage>>();
for (const entry of statuses.entries) {
  STAGES_BY_CODE.set(entry.code, (STAGES_BY_CODE.get(entry.code) ?? new Set<Stage>()).add(entry.stage as Stage));
}
const BY_CODE: ReadonlyMap<string, Stage> = new Map([...STAGES_BY_CODE].filter(([, stages]) => stages.size === 1)
  .map(([code, stages]) => [code, [...stages][0]!]));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => MAPPED.get(key(code, wording)) ?? (code ? BY_CODE.get(code) : undefined),
  gaps: [],
};

/** A row's stage, by its code and remark, else by the shared wording rules on the remark or the label, or none. */
export function cyxfxStage(wording: string, code: string, label = ''): ClassifiedWording | null {
  const stage = statusMap.stage(code, normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  for (const text of [wording, label]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}
