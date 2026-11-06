import type { AdapterFactory } from '../../core/adapter/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { MeestPortalTracker } from '../meest/client.js';
import { normalizePolonezNumber, parsePolonez, POLONEZ_MAX_BYTES, PROVIDER } from './parser.js';

export class PolonezTracker extends MeestPortalTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    super({ ...options, carrier: 'polonez', provider: PROVIDER, maxBytes: POLONEZ_MAX_BYTES,
      normalize: normalizePolonezNumber, parse: parsePolonez, networkOnlyRetry: true, strictRoute: true });
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new PolonezTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'polonez', recordsSteps: true, steps: ['direct', 'retry', 'refresh'], track: (input, context) => tracker.fetch(input.number, context) };
};
