import { ezyFmsAdapter, ezyFmsTrackerUrl, EzyFmsTracker } from './ezyfms.js';
import { TFMXPRESS } from './parser.js';

export { normalizeTfmxpressNumber, parseTfmxpress } from './parser.js';

/** TFMXpress's FreightTrax tracker, where its form posts. */
export const TFMXPRESS_TRACKER = ezyFmsTrackerUrl(TFMXPRESS);

export class TfmxpressTracker extends EzyFmsTracker {
  constructor(options: ConstructorParameters<typeof EzyFmsTracker>[1] = {}) { super(TFMXPRESS, options); }
}

export const adapter = ezyFmsAdapter(TFMXPRESS);
