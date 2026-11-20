import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { escapeRegExp } from '../../core/transport/text.js';
import evidence from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage: string }

const entries = evidence.entries as readonly Entry[];

/** A recorded wording as a whole-text pattern, its `{placeholders}` standing for the place, branch or name the scan names. */
function pattern(wording: string): RegExp {
  const parts = normalizeStatusWording(wording).split(/\{[a-z]+\}/);
  return new RegExp(`^${parts.map(escapeRegExp).join('.+?')}$`, 'u');
}

const RULES = entries.map((entry) => ({ code: entry.code ?? '', pattern: pattern(entry.wording), stage: entry.stage as Stage }));

/** The stage of a scan code whose recorded wordings all share one; a code with several stages needs its wording. */
const CODE_STAGES: ReadonlyMap<string, Stage> = new Map([...new Set(entries.flatMap((entry) => entry.code ?? []))]
  .flatMap((code) => {
    const stages = new Set(entries.filter((entry) => entry.code === code).map((entry) => entry.stage as Stage));
    return stages.size === 1 ? [[code, [...stages][0]!] as const] : [];
  }));

/**
 * A scan's stage: its code and wording as recorded, else its code alone when every wording
 * recorded for it shares a stage, else the shared wording rules, else nothing.
 */
export function wangjingStage(code: string, wording: string): ClassifiedWording | null {
  const text = normalizeStatusWording(wording);
  const rule = RULES.find((candidate) => candidate.code === code && candidate.pattern.test(text));
  if (rule) return { stage: rule.stage, source: 'carrier_map' };
  const coded = code ? CODE_STAGES.get(code) : undefined;
  if (coded) return { stage: coded, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads a scan's code and wording as `wangjingStage` does, without the shared wording rules. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = wangjingStage(code ?? '', wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
