import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { XINGHE_FREIGHT } from './parser.js';

export class XingheFreightTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(XINGHE_FREIGHT, options); }
}

/** Readers type Xinghe's waybills without their last letter: GZXH, ten digits and Y asks with the Q back. */
export function xingheFreightNumber(raw: string): string {
  const number = raw.replace(/\s+/g, '').toUpperCase();
  return /^GZXH\d{10}Y$/.test(number) ? `${number}Q` : raw;
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XingheFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'xinghe-freight', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(xingheFreightNumber(input.number), context) };
};
