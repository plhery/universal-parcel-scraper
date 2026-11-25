import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { WOKEXP } from './parser.js';

export class WokexpTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(WOKEXP, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WokexpTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'wokexp', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
