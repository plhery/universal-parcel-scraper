import { parcelPerfect } from '../bigfoot-express/parcelPerfect.js';
import { parseTracking } from './parser.js';

export const adapter = parcelPerfect('intertown-transport', 'https://intertown.pperfect.com', /^(?!0{8}$)\d{8}$/, parseTracking);
