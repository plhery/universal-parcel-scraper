import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { dateEdPostDhlRows, ED_POST } from './parser.js';

export class EdPostTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(ED_POST, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return dateEdPostDhlRows(await super.fetch(raw, context));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EdPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ed-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
