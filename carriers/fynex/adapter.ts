import type { AdapterFactory } from '../../core/adapter/index.js';
import { fynex } from './parser.js';
import { TssSmartTracker } from './tssSmart.js';

export { fynex, normalizeFynexNumber, parseFynex } from './parser.js';

// No recognition: FyNEX's seven digits are a shape many carriers share and no detection rule
// offers it, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new TssSmartTracker(fynex, environment);
  return {
    id: fynex.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
