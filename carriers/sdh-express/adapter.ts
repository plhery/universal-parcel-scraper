import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { SDH_EXPRESS } from './parser.js';

export class SdhExpressTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(SDH_EXPRESS, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SdhExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sdh-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
