/**
 * A FlowLink tenant's status map, apart from the request and reader so the catalog's status maps load it in the
 * browser.
 */
import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export interface FlowLinkEntry {
  readonly code: string;
  readonly wording: string;
  readonly stage: string;
}

/**
 * The form a row's text is listed under, from its `normalizeStatusWording` form: each place in brackets as […]
 * or 【…】, each run of six digits or more, such as an onward waybill, as #, and the branch, hub or pickup point
 * a relayed courier's row names as ….
 */
export function flowlinkTemplate(wording: string): string {
  return wording.replace(/【[^【】]*】/gu, '【…】').replace(/\[[^[\]]*\]/gu, '[…]').replace(/\d{6,}/gu, '#')
    .replace(/^(【…】 ?快件已(?:到达|发往)) .+$/u, '$1 …')
    .replace(/^(【…】) ?\S.*? (已揽收|的快递员正在为您派送)$/u, '$1… $2')
    .replace(/^(快件已暂存至)\S.*$/u, '$1…')
    .replace(/^(【…】预计)\d{1,2}月\d{1,2}日(到达【…】)$/u, '$1…$2');
}

/**
 * A tenant's status map from its `statuses.json`: the platform's code (`CNCode`, empty on many rows) with the
 * row's text, places and numbers aside. A code whose every recorded text means one stage gives it to a text the
 * map does not know.
 */
export function flowlinkStatusMap(entries: readonly FlowLinkEntry[]): CarrierStatusMap {
  const key = (code: string | null, wording: string) => JSON.stringify([code ?? '', flowlinkTemplate(normalizeStatusWording(wording))]);
  const mapped = new Map(entries.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));
  const stages = new Map<string, Set<Stage>>();
  for (const entry of entries) {
    if (entry.code) stages.set(entry.code, (stages.get(entry.code) ?? new Set<Stage>()).add(entry.stage as Stage));
  }
  const byCode = new Map([...stages].filter(([, set]) => set.size === 1).map(([code, set]) => [code, [...set][0]!]));
  return {
    stage: (code, wording) => mapped.get(key(code, wording)) ?? (code ? byCode.get(code) : undefined),
    gaps: [],
  };
}
