import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const PREFIXES = statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage] as const)
  .sort((a, b) => b[0].length - a[0].length);

function mapped(wording: string): Stage | undefined {
  const value = normalizeStatusWording(wording);
  return PREFIXES.find(([prefix]) => value === prefix || value.startsWith(prefix + ' '))?.[1];
}

export function wahanaStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? undefined : mapped(wording), gaps: [] };
