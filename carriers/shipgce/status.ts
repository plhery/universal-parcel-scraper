import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stageForWording(wording: string): Stage | undefined {
  if (/^货物已转运，USPS转运单号:/iu.test(wording)) return 'in_transit';
  return stages.get(normalizeStatusWording(wording));
}
