import type { Stage } from '../../core/status/index.js';
import { type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Brudam's occurrence codes as digits; the road system's collection events as `E<code>` and its
// other events by their step id, as `H<id>`.
const CODED: ReadonlyMap<string, Stage | null> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage | null]));

/** Brudam's billing records and customer-service tickets: not parcel events, so never read as events. */
export const HIDDEN_BRUDAM_CODES: ReadonlySet<string> = new Set(statuses.entries
  .filter((entry) => 'hidden' in entry && entry.hidden).map((entry) => entry.code));

/** A code's stage, in either system. */
export function codedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : CODED.get(code) ?? undefined;
}

/**
 * A road event's code, as the tracking page groups it: a scheduled collection (`E501`), a
 * completed one (`E503`) and the start of the transport (`E0`) by their event and Proceda codes,
 * every other event by its step id.
 */
export function rodoCode(historic: string | null, eventCode: string | null, procedaCode: string | null): string | null {
  if (eventCode === '501' || (eventCode === '0' && procedaCode === '00')) return 'E501';
  if (eventCode === '503' || (eventCode === '0' && procedaCode === '1')) return 'E503';
  if (eventCode === '0' && procedaCode === '0') return 'E0';
  return historic === null ? null : `H${historic}`;
}

/** Events are staged by their code; an occurrence the map leaves open stays visible for review. */
export const statusMap: CarrierStatusMap = {
  stage: codedStage,
  gaps: statuses.entries.filter((entry) => entry.stage === null)
    .map((entry) => ({ code: entry.code, note: entry.note ?? 'An occurrence that states no movement of the parcel.' })),
};
