import type { AdapterFactory } from '../../core/adapter/index.js';
import { retomsToken, RetomsTracker, type RetomsTrackerOptions } from '../kuayuan-express/retoms.js';
import { WLD } from './parser.js';

export { WLD_API } from './parser.js';

/** The token the track query page signs a guest's request made at `timestamp` with. */
export const wldToken = (timestamp: number): string => retomsToken(WLD, timestamp);

export class WldTracker extends RetomsTracker {
  constructor(options: RetomsTrackerOptions = {}) { super(WLD, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WldTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'wld-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
