import type { AdapterFactory } from '../../core/adapter/index.js';
import { DelyvaTracker } from './delyva.js';
import { BABYXPRESS, PROVIDER } from './parser.js';

export { normalizeBabyXpressNumber, parseBabyXpress } from './parser.js';

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DelyvaTracker(BABYXPRESS, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
