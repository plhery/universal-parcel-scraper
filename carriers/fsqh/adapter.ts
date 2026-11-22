import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { dateHualeiGofoRows } from '../gzyl/gofo-rows.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { FSQH } from './parser.js';

export class FsqhTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(FSQH, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return dateHualeiGofoRows(await super.fetch(raw, context));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FsqhTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fsqh', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
