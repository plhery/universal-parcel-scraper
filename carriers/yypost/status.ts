import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { withoutGofoSupportLine } from '../gofo/support.js';
import { imileSentenceStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * YYpost's scans are English wording from its warehouse in Shenzhen, its air
 * line through Hong Kong and the destination's clearance. The map is the
 * wording recorded in `statuses.json`; other wording goes to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

// GOFO's failed delivery attempt in the United States, whatever reason follows the comma, as
// GOFO's own map reads its code 206.
const GOFO_ATTEMPT = /^delivery exception, /;

// iMile's scans on its last mile, its sentence after YYpost's event name: "Delivery, Your order has arrived
// at 【…】". They read as iMile's map reads them, and its delivery day booked moves nothing.
const IMILE_LEG = /^delivery, (?=\S)/;

/**
 * The map's stage for a wording, as it came or in `normalizeStatusWording` form, null for one that moves
 * nothing. GOFO's relayed scans keep the support line GOFO appends to some of them, which the map reads without.
 */
function mappedStage(wording: string): Stage | null | undefined {
  const stripped = withoutGofoSupportLine(wording);
  const text = stripped === wording ? wording : stripped.replace(/\.$/, '');
  const mapped = WORDINGS.get(normalizeStatusWording(text)) ?? (GOFO_ATTEMPT.test(text.toLowerCase()) ? 'failed_attempt' : undefined);
  const leg = mapped ? null : IMILE_LEG.exec(text.toLowerCase());
  return leg ? imileSentenceStage('', text.slice(leg[0].length)) : mapped;
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function yypostStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (mapped === null) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans carry no code the adapter reads; the map reads the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mappedStage(wording) ?? undefined),
  gaps: [],
  gapNote: (code, wording) => (!code && mappedStage(wording) === null
    ? "iMile's delivery day booked, on its last mile: it moves nothing, so the parcel keeps the stage it had." : undefined),
};
