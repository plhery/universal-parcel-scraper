import { parcelPerfect } from '../bigfoot-express/parcelPerfect.js';
import { parseTracking } from './parser.js';

// The tenant's waybills end in ACT, and its service answers only the whole waybill with that suffix.
export const adapter = parcelPerfect('act-logistics', 'https://actlogistics.pperfect.com', /^\d{5,10}ACT$/, parseTracking);
