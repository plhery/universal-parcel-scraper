import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status codes the tracker prints in its Status column, which carry no other wording.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
// A numbered delivery attempt, of which the tracker has shown the first: "ATTEMPT1ST".
const ATTEMPT = /^ATTEMPT\d{1,2}(?:ST|ND|RD|TH)$/;

/** The stage of one of SPC's status codes; one it does not list has none. */
export function spcCodeStage(code: string): Stage | undefined {
  return CODED.get(code) ?? (ATTEMPT.test(code) ? 'failed_attempt' : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? spcCodeStage(code) : undefined),
  gaps: [],
};
