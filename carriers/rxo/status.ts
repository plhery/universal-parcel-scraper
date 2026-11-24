import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The exceptions and order statuses the adapter reads, by their code.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code !== undefined).map((entry) => [entry.code, entry.stage as Stage]));
// The tracker's event wordings, whole. Its events carry no code.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code === undefined).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

const SERVICE_NOTE = 'An installation or repair visit after the delivery, which moves no parcel: the stage of the scan before it holds.';

// A service visit that was not performed: its exception's wording, without the code.
const SERVICE_EXCEPTION = /^cannot (?:perform stop|pickup\/deliver item)\b/;

function stage(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(normalizeStatusWording(wording)) : CODED.get(code.toUpperCase());
}

/** Events are staged by their whole wording; a stop's exception and the order's status by their code. */
export const statusMap: CarrierStatusMap = {
  stage,
  gaps: [
    { wording: 'driver is on the route for the service', note: SERVICE_NOTE },
    { wording: 'driver has arrived at the service location', note: SERVICE_NOTE },
    { wording: 'service completed', note: SERVICE_NOTE },
  ],
  gapNote: (code, wording) => code === null && SERVICE_EXCEPTION.test(wording) ? SERVICE_NOTE : undefined,
  wholeWording: true,
};
