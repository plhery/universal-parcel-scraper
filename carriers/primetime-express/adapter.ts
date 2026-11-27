import { parcelPerfect } from '../bigfoot-express/parcelPerfect.js';
import { parseTracking } from './parser.js';

// The tracker sends what is typed, upper-cased, without a mask, and no public waybill shows the shape.
export const adapter = parcelPerfect('primetime-express', 'https://primetimeexpress.pperfect.com', /^[A-Z\d]{5,20}$/, parseTracking);
