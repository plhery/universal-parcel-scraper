import { parcelPerfectStages, parcelPerfectStatusMap } from '../bigfoot-express/parcelPerfectStages.js';
import statuses from './statuses.json' with { type: 'json' };

/** The stage of a scan's wording, whatever depot it names. */
export const stageOf = parcelPerfectStages(statuses.entries);

export const statusMap = parcelPerfectStatusMap(stageOf);
