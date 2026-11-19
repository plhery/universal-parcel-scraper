import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The receiving terminal's name follows the wording, as in "Received At Moran Fort Wayne"; the stage does not depend on it.
const TERMINAL = /^(received at moran)\b.*$/is;
const key = (wording: string) => normalizeStatusWording(wording.trim().replace(TERMINAL, '$1'));
const stages = new Map(statuses.entries.map(entry => [key(entry.wording), entry.stage as Stage]));

export function stageOf(wording: string): Stage | undefined {
  return stages.get(key(wording));
}

/** Whether the scan is a truck en route, which after the round has started is the round. */
export function isEnRoute(wording: string): boolean {
  return key(wording) === 'en-route';
}

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = stageOf(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
