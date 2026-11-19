import type { AdapterFactory } from '../../core/adapter/index.js';
import { CourierPortalTracker } from '../logisimple/portal.js';
import { rapex } from './parser.js';

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CourierPortalTracker(rapex, environment);
  return {
    id: rapex.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
