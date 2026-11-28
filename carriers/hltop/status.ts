/**
 * Hailian's rows: a status word, a comma or a colon, then the scan's words with the station unbracketed, as in
 * 运送中, 快件到达 上海浦江中转场; the first row names its station before the words. An entry of `statuses.json`
 * is listed under its status word, or, without one, under its words with the leading station as an ellipsis; a
 * text the map does not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// "运送中, …" or "客户签收: …": the status word a row starts with, alone when the rest named the courier.
const STATUS_WORD = /^([^\s,，:：]{2,8})\s*(?:[,，:：]|$)/u;

/** The form a text is listed under: its status word, else its words after the leading station. */
const template = (wording: string): string => STATUS_WORD.exec(wording)?.[1]
  ?? wording.replace(/^\S{2,30}\s+(?=\S)/u, '… ');

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [template(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(template(wording)),
  gaps: [],
};

/** A row's stage, by its status word or text in `statuses.json`, else by the shared wording rules, or none. */
export function hltopStage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(template(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
