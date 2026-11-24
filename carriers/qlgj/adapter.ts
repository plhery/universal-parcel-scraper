import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { dateQlgjDhlRows, QLGJ } from './parser.js';

export class QlgjTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(QLGJ, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return dateQlgjDhlRows(await super.fetch(raw, context));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QlgjTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'qlgj', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
