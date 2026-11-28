/**
 * Tuxing Supply Chain's rows: a text without a code, its own or one the courier in China wrote. An entry of
 * `statuses.json` records a text with each bracket as …, a Deppon row's station before its first comma as …,
 * and the stations and box numbers a row names after its status as …; a text the map does not know goes through
 * the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The form a text is listed under, from its `normalizeStatusWording` form. */
export function zgtuxTemplate(wording: string): string {
  let text = wording;
  for (let pass = 0; pass < 3 && /【[^【】]*】/u.test(text); pass += 1) text = text.replace(/【[^【】]*】/gu, '…');
  return text.replace(/^…?[^，,…]*(?:营业部|转运场|转运中心|分拨中心|中转场|集散中心|网点|站|点部)，/u, '…，')
    .replace(/^(…，运输中，(?:到达|离开)).+$/u, '$1…')
    .replace(/^.+(分拣中心已收箱，箱号).+$/u, '…$1…')
    .replace(/(收件员揽收),.+$/u, '$1,…');
}

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [zgtuxTemplate(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(zgtuxTemplate(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function zgtuxStage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(zgtuxTemplate(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
