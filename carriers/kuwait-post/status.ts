import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { laPosteBurkinaFasoEventStage } from '../la-poste-burkina-faso/status.js';

/**
 * The tracker gives the UPU IPS system's English event names with their leg, for Kuwait Post's
 * scans and for those other posts reported, as La Poste Burkina Faso's IPS page does. Its map
 * reads them without the leg.
 */
export function kuwaitPostEventStage(name: string): Stage | undefined {
  return laPosteBurkinaFasoEventStage(name);
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function kuwaitPostStage(name: string): ClassifiedWording | null {
  const mapped = kuwaitPostEventStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * A scan's wording is its event name, then its non-delivery and retention details after a
 * colon; the event name sets the stage. The event codes are IPS's own numbers, not read.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : kuwaitPostEventStage(wording.split(': ')[0]!)),
  gaps: [],
};
