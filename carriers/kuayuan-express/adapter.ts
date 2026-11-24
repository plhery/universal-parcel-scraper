import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { KUAYUAN, normalizeKuayuanNumber } from './parser.js';
import { RetomsTracker, type RetomsTrackerOptions } from './retoms.js';

export { KUAYUAN_API } from './parser.js';

export class KuayuanTracker extends RetomsTracker {
  constructor(options: RetomsTrackerOptions = {}) { super(KUAYUAN, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KuayuanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kuayuan-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKuayuanNumber(number))),
  };
};
