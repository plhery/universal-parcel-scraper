/**
 * A DsyExpress tenant's status map, apart from the request and reader so the catalog's status maps load it in
 * the browser. An entry of `statuses.json` records a row's text in the form `dsyTemplate` gives it: each bracket
 * as 【…】 unless the row is one bracket, each run of digits as …, the waybill after 单号 as …, and the town or
 * station a relayed courier's row names as …. A text the map does not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export interface DsyStatusEntry {
  readonly wording: string;
  readonly stage: string;
}

/** The form a text is listed under, from its `normalizeStatusWording` form. */
export function dsyTemplate(wording: string): string {
  // The line-haul feed writes some rows as one bracket: their words are the text.
  if (/^【[^【】]*】$/u.test(wording)) return wording.replace(/\d+/gu, '…');
  return wording.replace(/【[^【】]*】/gu, '【…】')
    .replace(/单号\s*[:：]\s*(?:[a-z0-9]+|…)/gu, '单号：…')
    // The town a courier's row opens with before its station: "北京市【…】，已签收", "到北京市【…】".
    .replace(/^(到)?\p{Script=Han}{2,6}?[市县州盟区](?=【…】)/u, '$1…')
    // The station a courier's row names after its verb, or before what it did there.
    .replace(/(已到达|已离开|发往)\s+[^\s，,；;。【】]+/gu, '$1 …')
    .replace(/^(【…】)[^\s【】]+\s+(?=正在为您派送|已揽收)/u, '$1… ')
    .replace(/\d+/gu, '…');
}

/** A tenant's status map from its `statuses.json`, read by each entry's form. */
export function dsyStatusMap(entries: readonly DsyStatusEntry[]): CarrierStatusMap {
  const templates = new Map(entries.map((entry) => [dsyTemplate(normalizeStatusWording(entry.wording)), entry.stage as Stage]));
  return {
    stage: (_code, wording) => templates.get(dsyTemplate(wording)),
    gaps: [],
    wholeWording: true,
  };
}

/** A row's stage, by the tenant's map, else by the shared wording rules, or none. */
export function dsyStage(map: CarrierStatusMap, description: string): ClassifiedWording | null {
  const stage = map.stage(null, normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
