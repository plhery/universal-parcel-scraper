import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const wordings = new Map<string, Stage>(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stageForScan(code: string, wording: string): Stage | undefined {
  if (code === 'POD') return 'delivered';
  if (code === 'RTO') return 'returned';
  const normalized = normalizeStatusWording(wording);
  if (/^sent to /.test(normalized)) return 'in_transit';
  return wordings.get(normalized);
}

/** The map reads a scan's code, else its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => stageForScan(code ?? '', wording),
  gaps: [],
};
