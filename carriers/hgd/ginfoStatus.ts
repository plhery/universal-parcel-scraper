/**
 * The stages of a GInfo tenant's rows, apart from the reader so that the
 * status maps browsers load carry no transport.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** An entry of a tenant's `statuses.json`. */
interface GinfoStatusEntry { readonly code?: string; readonly wording?: string; readonly stage?: string }

/**
 * A tenant's stages from its `statuses.json`: a row's code and wording as an
 * entry records them, else the shared wording rules on the wording, else none.
 */
export function ginfoStatus(entries: readonly GinfoStatusEntry[]): {
  stage: (wording: string, code?: string) => ClassifiedWording | null; statusMap: CarrierStatusMap;
} {
  const key = (code: string | null | undefined, wording: string) => JSON.stringify([code ?? '', normalizeStatusWording(wording)]);
  const mapped: ReadonlyMap<string, Stage> = new Map(entries.flatMap((entry) => entry.wording && entry.stage
    ? [[key(entry.code, entry.wording), entry.stage as Stage] as const] : []));
  return {
    stage: (wording, code = '') => {
      const stage = mapped.get(key(code, wording));
      if (stage) return { stage, source: 'carrier_map' };
      const worded = classifyWording(wording, 'in_transit');
      return worded.source === 'none' ? null : worded;
    },
    statusMap: { stage: (code, wording) => mapped.get(key(code, wording)), gaps: [] },
  };
}
