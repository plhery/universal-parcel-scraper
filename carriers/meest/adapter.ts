import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { MeestPortalTracker } from './client.js';
import { MEEST_MAX_BYTES, normalizeMeestNumber, parseMeest, PROVIDER } from './parser.js';

export { MEEST_LOOKUP, MEEST_PAGE, meestLookupUrl, meestPageSalt } from './client.js';

export class MeestTracker extends MeestPortalTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    super({ ...options, carrier: 'meest', provider: PROVIDER, maxBytes: MEEST_MAX_BYTES,
      normalize: normalizeMeestNumber, parse: parseMeest });
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MeestTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'meest', recordsSteps: true, steps: ['direct', 'refresh'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMeestNumber(number))),
  };
};
