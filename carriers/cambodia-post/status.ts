import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { laPosteBurkinaFasoEventStage } from '../la-poste-burkina-faso/status.js';

/**
 * The tracker prints the UPU IPS system's English event names with their leg, for Cambodia
 * Post's scans and for those the posting country reported, as La Poste Burkina Faso's IPS page
 * does. Its map reads them without the leg.
 */
export function cambodiaPostEventStage(name: string): Stage | undefined {
  return laPosteBurkinaFasoEventStage(name);
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function cambodiaPostStage(name: string): ClassifiedWording | null {
  const mapped = cambodiaPostEventStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A scan's wording is its event name, then the details of its extra
 * information after a colon; the event name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : cambodiaPostEventStage(wording.split(': ')[0]!)),
  gaps: [],
};
