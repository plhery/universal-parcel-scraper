import type { AdapterFactory } from '../../core/adapter/index.js';
import { CourierPortalTracker } from '../logisimple/portal.js';
import { activos24 } from './parser.js';

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CourierPortalTracker(activos24, environment);
  return {
    id: activos24.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
