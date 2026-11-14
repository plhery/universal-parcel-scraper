import { carrierIdFromName } from '../../core/catalog/hints.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/language.js';
import { scopedWordingStage } from '../../core/status/scoped.js';
import type { Stage } from '../../generated/catalog.js';

/**
 * A provider's copies read by the wording rules scoped to the carrier behind them (`scopedWordingStage`):
 * the carrier a scan names (`reporting_carrier`), else the parcel's carrier (`discovered_carrier`) when the
 * provider names no other. A scan naming a carrier the catalog does not know has none. A rule outranks the
 * shared rules' reading of its wording, never a carrier's map. When a scan it reads becomes the newest with a
 * stage, the result's stage follows it.
 */
export function withScopedWording(result: CarrierResult, source: string): CarrierResult {
  const events: CarrierEvent[] = Array.isArray(result.events) ? result.events : [];
  const named = Array.isArray(result.reported_carriers) ? result.reported_carriers : [];
  // With several names the scans can be another leg's.
  const parcel = typeof result.discovered_carrier === 'string' && named.length <= 1 ? result.discovered_carrier : null;
  const read = new Set<CarrierEvent>();
  const scoped = events.map((event) => {
    if (event.stage_source === 'carrier_map') return event;
    const carrier = typeof event.reporting_carrier === 'string' ? carrierIdFromName(event.reporting_carrier) ?? null : parcel;
    const stage = scopedWordingStage(event.description ?? '', { carrier, provider: source });
    if (!stage || stage === event.stage) return event;
    const restaged = { ...event, stage, stage_source: 'wording:provider' };
    read.add(restaged);
    return restaged;
  });
  if (!read.size) return result;
  const current = scoped.find((event) => event.stage && event.stage !== 'pending');
  return { ...result, events: scoped, ...(current && read.has(current) ? {
    status: languageStageStatus(current.stage as Stage), current_stage: current.stage, current_stage_source: current.stage_source,
  } : {}) };
}
