import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null, wording: string) => JSON.stringify([code, normalizeStatusWording(wording)]);
// The scans seen, by their code and wording.
const ROWS: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));

/**
 * The statuses a scan is filed under (`eventStatus`), the part of a code before its underscore. The
 * service names only these four; any other status is left to the scan's wording.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['InfoReceived', 'registered'],
  ['InTransit', 'in_transit'],
  ['OutForDelivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
]);

/**
 * A scan's stage, by its code (the sub-status when it has one, else the status) and wording. A scan
 * seen before keeps its recorded stage, as the collection filed under transit does. Otherwise the
 * status decides, except that transit, the status every depot scan has, yields to wording the shared
 * rules read as another stage, such as a return. A status the service has not shown is read by its
 * wording alone.
 */
export function ecparcelStage(code: string | null, wording: string): ClassifiedWording | null {
  const seen = ROWS.get(key(code, wording));
  if (seen) return { stage: seen, source: 'carrier_map' };
  const status = code === null ? undefined : STATUSES.get(code.split('_')[0]!);
  const worded = classifyWording(wording, 'pending');
  if (status && (status !== 'in_transit' || worded.source === 'none' || worded.stage === 'in_transit')) {
    return { stage: status, source: 'carrier_map' };
  }
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = ecparcelStage(code, wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
