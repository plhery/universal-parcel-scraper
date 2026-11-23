import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { GetOnlineTracker } from '../skynet-worldwide/getonline.js';
import { normalizeSkyquickNumber, SKYQUICK } from './parser.js';

export class SkyquickTracker extends GetOnlineTracker {
  constructor(options: ConstructorParameters<typeof GetOnlineTracker>[1] = {}) { super(SKYQUICK, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkyquickTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skyquick', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeSkyquickNumber(number))),
  };
};
