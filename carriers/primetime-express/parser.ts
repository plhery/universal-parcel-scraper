import { parcelPerfectHistory } from '../bigfoot-express/parcelPerfect.js';
import { stageOf } from './status.js';

export const parseTracking = parcelPerfectHistory('primetime-express', stageOf);
