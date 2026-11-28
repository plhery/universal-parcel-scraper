/**
 * MoreLink's rows: a status word, then a remark after a space ("已开船 凌晨5点开船"). The status word is read by
 * `statuses.json`; a status word it does not list goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STATUS_WORDS: ReadonlyMap<string, Stage> = new Map(statuses.entries.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const NOTICES: ReadonlyMap<string, string> = new Map(statuses.entries.filter((entry) => !entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.note]));

/** The status word a row starts with, before its remark. */
export function statusWord(wording: string): string {
  return normalizeStatusWording(wording).split(' ')[0] ?? '';
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STATUS_WORDS.get(statusWord(wording)),
  gaps: [],
  gapNote: (code, wording) => (code === null ? NOTICES.get(statusWord(wording)) : undefined),
};

/** A row's stage, by its status word in `statuses.json`, else by the shared wording rules, or none for a notice. */
export function morelinkStage(description: string): ClassifiedWording | null {
  const word = statusWord(description);
  const stage = STATUS_WORDS.get(word);
  if (stage) return { stage, source: 'carrier_map' };
  if (NOTICES.has(word)) return null;
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
