import { parcelPerfect } from './parcelPerfect.js';
import { parseTracking } from './parser.js';

export const adapter = parcelPerfect('bigfoot-express', 'https://bigfootexpress.pperfect.com', /^(?:[A-Z]{2}\d{7}|[A-Z]{3}\d{6})$/, parseTracking);
