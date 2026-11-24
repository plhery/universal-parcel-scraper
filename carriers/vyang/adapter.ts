import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { dateVyangDhlRows, VYANG } from './parser.js';

export class VyangTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(VYANG, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return dateVyangDhlRows(await super.fetch(raw, context));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VyangTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vyang', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
