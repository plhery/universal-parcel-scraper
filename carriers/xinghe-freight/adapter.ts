import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { PROVIDER, XINGHE_FREIGHT } from './parser.js';

export class XingheFreightTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(XINGHE_FREIGHT, options); }
}

/**
 * Readers type Xinghe's waybills without their last letter: GZXH, ten digits and Y asks with the Q back.
 * A waybill with a digit too few or too many is a typo the tracker never holds: it is refused before
 * asking, so the reader checks the number rather than waiting for scans that never come.
 */
export function xingheFreightNumber(raw: string): string {
  const number = raw.replace(/\s+/g, '').toUpperCase();
  if (/^GZXH\d{10}Y$/.test(number)) return `${number}Q`;
  if (/^GZXH\d+YQ?$/.test(number) && !/^GZXH\d{10}YQ$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Xinghe Freight waybills have GZXH, ten digits and YQ');
  }
  return raw;
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XingheFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'xinghe-freight', recordsSteps: true, steps: ['direct', 'retry'], track: async (input, context) => tracker.fetch(xingheFreightNumber(input.number), context) };
};
