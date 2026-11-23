import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { GTI } from './parser.js';

export class GtiTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(GTI, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GtiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gti', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
