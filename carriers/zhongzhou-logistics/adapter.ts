import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { ZHONGZHOU_LOGISTICS } from './parser.js';

export class ZhongzhouLogisticsTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(ZHONGZHOU_LOGISTICS, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZhongzhouLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zhongzhou-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
