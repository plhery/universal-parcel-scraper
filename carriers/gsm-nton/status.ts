import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// expressWeb's status codes, the same for every forwarder on the platform, with the
// English and Korean wording seen with each. A departure or arrival ends with its airport or port.
const PLACE = /\s*\([A-Z]{3,5}\)$/;
const key = (wording: string) => normalizeStatusWording(wording.replace(PLACE, ''));

const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [key(entry.wording), entry.stage as Stage]));

/** The stage of a row's status code. */
export const expresswebCodeStage = (code: string): Stage | undefined => CODED.get(code);

/** The stage of a bill's current status, which the header words without its code. */
export const expresswebWordingStage = (wording: string): Stage | undefined => WORDED.get(key(wording));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODED.get(code) : WORDED.get(key(wording))),
  gaps: [],
};
