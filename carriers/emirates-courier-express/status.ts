import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap, IntentionalStatusGap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Stages by the scan's code: a milestone's three letters, or an exception's group (DLX, PUX,
 * SHX, CAX, CRX, SCX, LHX) followed by the piece's reason, as the tracking page's own list of
 * codes writes them. The wording follows the code and is not read.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries.flatMap((entry) => ('stage' in entry && typeof entry.stage === 'string'
  ? [[entry.code, entry.stage as Stage] as const] : [])));

/** Notices that move nothing: they keep the stage of the scan before them. */
const GAPS: readonly IntentionalStatusGap[] = statuses.entries.flatMap((entry) => ('unmapped' in entry && entry.unmapped
  ? [{ code: entry.code, note: entry.note }] : []));

// An exception's group and reason, as "DLXREFO".
const EXCEPTION = /^([A-Z]{2}X)[A-Z0-9]{2,6}$/;

/** A scan's stage by its code, else by its exception group when the map does not know the reason. */
export function emiratesCourierStage(code: string | null): Stage | undefined {
  if (!code) return undefined;
  const known = CODES.get(code);
  if (known) return known;
  const group = EXCEPTION.exec(code)?.[1];
  return group && !GAPS.some((gap) => gap.code === code) ? CODES.get(group) : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => emiratesCourierStage(code),
  gaps: GAPS,
};
